import { createPrivateKey, createHash, sign, type KeyObject } from 'node:crypto';

/** 和风三种认证方式：API Key（请求头）、已签好的静态 JWT（仅临时排查）、私钥现签 JWT（推荐）。 */
export type QWeatherAuth =
  | { mode: 'api-key'; apiKey: string }
  | { mode: 'token'; token: string }
  | { mode: 'jwt'; keyId: string; developerId: string; projectId: string; privateKey: string };

/** 和风 JWT 有效期上限 24 小时；15 分钟一签，留 5 分钟余量重签。 */
export const QWEATHER_JWT_TTL_SECONDS = 900;
const RENEW_MARGIN_MS = 300_000;

/** 静态 JWT 形如 header.payload.signature（三段 Base64URL），用来和 API Key 区分。 */
export function looksLikeJwt(value: string): boolean {
  return value.startsWith('eyJ') && value.split('.').length === 3;
}

/** `.env` 里私钥的三种常见写法都要能解析：多行原样、多行写成字面量 `\n`、
 * 或者**完全没换行**（`-----BEGIN X-----<base64>-----END X-----` 一行写完）。
 * 最后一种 OpenSSL 会报 `DECODER routines::unsupported`，必须先补换行，这是最容易踩的坑。 */
export function normalizePem(pem: string): string {
  const collapsed = pem.replace(/\\n/g, '\n').trim();
  const match = /^-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----\s*$/.exec(collapsed);
  if (!match) return collapsed;
  const body = match[2]!.replace(/\s/g, '');
  return `-----BEGIN ${match[1]}-----\n${(body.match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${match[1]}-----\n`;
}

export function parseQWeatherPrivateKey(pem: string): KeyObject {
  return createPrivateKey(normalizePem(pem));
}

/** Ed25519（EdDSA）签名。Node 要求 Ed25519 的 algorithm 传 null，不能传 'EdDSA'。 */
export function signQWeatherJwt(auth: Extract<QWeatherAuth, { mode: 'jwt' }>, key: KeyObject, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 30;   // 回拨 30 秒，容忍服务器时钟误差
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: auth.keyId })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: auth.developerId, sub: auth.projectId, iat, exp: iat + QWEATHER_JWT_TTL_SECONDS })).toString('base64url');
  const data = `${header}.${payload}`;
  return `${data}.${sign(null, Buffer.from(data), key).toString('base64url')}`;
}

/** 凭据身份：用于缓存签名结果与隔离天气缓存。私钥只参与哈希，永不明文外泄。 */
export function qweatherIdentity(auth: QWeatherAuth): string {
  return createHash('sha256').update(JSON.stringify(auth)).digest('hex');
}

const signed = new Map<string, { header: Record<string, string>; expiresAt: number }>();

/** 请求头由认证方式决定：API Key 走 X-QW-Api-Key，JWT 走 Authorization: Bearer。Key/token 不进 URL。 */
export function qweatherAuthHeader(auth: QWeatherAuth, now = Date.now()): Record<string, string> {
  if (auth.mode === 'api-key') return { 'X-QW-Api-Key': auth.apiKey };
  if (auth.mode === 'token') return { Authorization: `Bearer ${auth.token}` };
  const cacheKey = `${auth.keyId}:${auth.developerId}:${auth.projectId}`;
  const cached = signed.get(cacheKey);
  if (cached && cached.expiresAt - RENEW_MARGIN_MS > now) return cached.header;
  const header = { Authorization: `Bearer ${signQWeatherJwt(auth, parseQWeatherPrivateKey(auth.privateKey), now)}` };
  signed.set(cacheKey, { header, expiresAt: now + QWEATHER_JWT_TTL_SECONDS * 1000 });
  return header;
}
