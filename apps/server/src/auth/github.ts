// GitHub OAuth（web application flow，手写最小实现）：
// access token 仅用于拉取一次身份，用完即弃不落库；账号关联只信 primary && verified 邮箱
import { env } from '../env';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_USER_URL = 'https://api.github.com/user';
const API_EMAILS_URL = 'https://api.github.com/user/emails';
const USER_AGENT = 'tripweaver';

export const OAUTH_STATE_COOKIE = 'tw_oauth_state';
export const OAUTH_STATE_TTL_S = 600;

/** 登录失败时经 /login?error=<code> 回传给前端的错误码 */
export type GithubOauthErrorCode =
  | 'github_denied'
  | 'github_state'
  | 'github_failed'
  | 'no_verified_email'
  | 'signup_closed';

export class GithubOauthError extends Error {
  constructor(public readonly code: GithubOauthErrorCode, detail = '') {
    super(`github oauth: ${code}${detail ? ` (${detail})` : ''}`);
  }
}

export function githubCallbackUrl(): string {
  return `${env.appBaseUrl}/api/auth/github/callback`;
}

export function buildAuthorizeUrl(state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', env.github.clientId);
  url.searchParams.set('redirect_uri', githubCallbackUrl());
  url.searchParams.set('scope', 'user:email');          // 最小 scope：/user 无需 scope，verified 邮箱需要它
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeCode(code: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({
      client_id: env.github.clientId,
      client_secret: env.github.clientSecret,
      code,
      redirect_uri: githubCallbackUrl(),
    }),
  });
  // 该端点出错时可能仍返回 200，必须检查 body.error 而非状态码
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || data.error || !data.access_token) {
    throw new GithubOauthError('github_failed', data.error ?? `http ${res.status}`);
  }
  return data.access_token;
}

export interface GithubIdentity {
  githubId: string;   // GitHub 数字 id（永久键；login/email 均可变，不能作键）
  email: string;      // primary && verified，已小写归一
}

export async function fetchGithubIdentity(token: string): Promise<GithubIdentity> {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT };
  const [userRes, emailsRes] = await Promise.all([
    fetch(API_USER_URL, { headers }),
    fetch(API_EMAILS_URL, { headers }),
  ]);
  if (!userRes.ok || !emailsRes.ok) {
    throw new GithubOauthError('github_failed', `user ${userRes.status} / emails ${emailsRes.status}`);
  }
  const user = (await userRes.json()) as { id?: number };
  const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
  if (typeof user.id !== 'number') throw new GithubOauthError('github_failed', 'missing user id');
  const primary = emails.find((e) => e.primary && e.verified);
  if (!primary) throw new GithubOauthError('no_verified_email');
  return { githubId: String(user.id), email: primary.email.trim().toLowerCase() };
}
