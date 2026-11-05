import { Button, buttonClassName } from '../components/ui/Button';
import { Input } from '../components/ui/Field';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthConfig, useLogin } from '../api/hooks';

// GitHub OAuth 回调失败经 /login?error=<code> 回传
const OAUTH_ERRORS: Record<string, string> = {
  github_denied: 'GitHub 授权已取消',
  github_state: '登录状态校验失败，请重试',
  github_failed: 'GitHub 登录失败，请稍后重试',
  no_verified_email: 'GitHub 账号缺少已验证的邮箱，无法登录',
  signup_closed: '注册暂未开放，无法通过 GitHub 创建新账号',
};

export function LoginPage({ embedded = false, from: destination, onSuccess, onRegister, onForgotPassword }: { embedded?: boolean; from?: string; onSuccess?: () => void; onRegister?: () => void; onForgotPassword?: () => void }) {
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { data: config } = useAuthConfig();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const oauthError = searchParams.get('error');
  const [error, setError] = useState(oauthError ? (OAUTH_ERRORS[oauthError] ?? '登录失败，请重试') : '');

  const state: unknown = location.state;
  const requested = destination ?? (typeof state === 'object' && state !== null && 'from' in state && typeof state.from === 'string' ? state.from : '/');
  const from = requested.startsWith('/') && !requested.startsWith('//') && !requested.includes('\\') && !/^\/(login|register)([/?#]|$)/.test(requested) ? requested : '/';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    login.mutate(
      { email, password },
      {
        onSuccess: () => { onSuccess?.(); void navigate(from, { replace: true, state: null }); },
        onError: (err) => setError(err.message),
      },
    );
  };

  return (
    <div className={embedded ? "auth-page" : "auth-page min-h-dvh flex items-center justify-center px-4 py-6"}>
      <div className={embedded ? "auth-card w-full" : "auth-card w-full [max-width:380px] [background:var(--color-card)] [border:1px_solid_var(--color-border)] [border-radius:14px] [box-shadow:var(--shadow)] [padding:28px_24px] [&_.brand]:[font-size:1.4rem]"}>
        <form onSubmit={submit} className={"form flex flex-col [gap:12px] [&_label]:flex [&_label]:flex-col [&_label]:[gap:5px] [&_label]:[font-size:0.88rem] [&_label]:[color:var(--color-muted)]"}>
          <label>
            邮箱
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </label>
          <label>
            密码
            <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          {error && <p role="alert" className={"form-error [color:var(--color-danger)] [font-size:0.85rem] m-0"}>{error}</p>}
          {onForgotPassword && (
            <Button variant="plain" className="self-end [font-size:0.82rem] text-brand hover:underline" disabled={login.isPending} onClick={onForgotPassword}>忘记密码？</Button>
          )}
          <Button variant="primary" type="submit" className={"btn-block w-full justify-center"} loading={login.isPending}>
            {login.isPending ? '登录中…' : '登录'}
          </Button>
        </form>
        {config?.githubEnabled && (
          <>
            <div className={"auth-divider flex items-center [gap:10px] [margin:14px_0_10px] [font-size:0.82rem] [color:var(--color-muted)] [&::before]:[content:''] [&::before]:flex-1 [&::before]:[height:1px] [&::before]:[background:var(--color-border)] [&::after]:[content:''] [&::after]:flex-1 [&::after]:[height:1px] [&::after]:[background:var(--color-border)]"}>或</div>
            <a className={`${buttonClassName('secondary')} box-border w-full no-underline`} href="/api/auth/github">使用 GitHub 登录</a>
          </>
        )}
        <p className={"auth-switch [margin:16px_0_0] [font-size:0.88rem] [color:var(--color-muted)]"}>
          还没有账号？{onRegister
            ? <Button variant="plain" className="text-sm text-brand hover:underline" disabled={login.isPending} onClick={onRegister}>{config?.registrationMode === 'invite' ? '用邀请码注册' : '注册'}</Button>
            : <Link to="/register" state={{ from }}>{config?.registrationMode === 'invite' ? '用邀请码注册' : '注册'}</Link>}
        </p>
      </div>
    </div>
  );
}
