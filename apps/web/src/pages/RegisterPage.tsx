import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Field';
import { EmailCodeField, checkEmail } from '../components/EmailCodeField';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthConfig, useRegister } from '../api/hooks';
import { ApiError } from '../api/client';

export function RegisterPage({ embedded = false, from: destination, onSuccess, onLogin }: { embedded?: boolean; from?: string; onSuccess?: () => void; onLogin?: () => void }) {
  const register = useRegister();
  const navigate = useNavigate();
  const location = useLocation();
  const state: unknown = location.state;
  const requested = destination ?? (typeof state === 'object' && state !== null && 'from' in state && typeof state.from === 'string' ? state.from : '/');
  const from = requested.startsWith('/') && !requested.startsWith('//') && !requested.includes('\\') && !/^\/(login|register)([/?#]|$)/.test(requested) ? requested : '/';
  const { data: config } = useAuthConfig();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [emailTaken, setEmailTaken] = useState(false);

  const inviteRequired = config?.registrationMode === 'invite';
  // open 模式没有邀请码门槛，改用邮箱验证码证明邮箱归属（10-18）
  const codeRequired = config?.registrationMode === 'open';
  const mailMissing = codeRequired && config?.emailCodeEnabled === false;
  const closed = config?.registrationMode === 'closed';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setEmailTaken(false);
    // 应用层格式校验：浏览器 type=email 会放行 a@b，后端正则才拦，报错只剩「请求参数不正确」
    const invalid = checkEmail(email);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    if (codeRequired && code.length !== 6) {
      setError('请输入 6 位邮箱验证码');
      return;
    }
    setError('');
    register.mutate(
      { email, password, ...(inviteRequired ? { inviteCode } : {}), ...(codeRequired ? { code } : {}) },
      {
        onSuccess: () => { onSuccess?.(); void navigate(from, { replace: true, state: null }); },
        onError: (err) => {
          setError(err.message);
          if (err instanceof ApiError && err.status === 409) setEmailTaken(true);
        },
      },
    );
  };

  return (
    <div className={embedded ? "auth-page" : "auth-page min-h-dvh flex items-center justify-center px-4 py-6"}>
      <div className={embedded ? "auth-card w-full" : "auth-card w-full [max-width:380px] [background:var(--color-card)] [border:1px_solid_var(--color-border)] [border-radius:14px] [box-shadow:var(--shadow)] [padding:28px_24px] [&_.brand]:[font-size:1.4rem]"}>
        {closed ? (
          <p className={"form-error [color:var(--color-danger)] [font-size:0.85rem] m-0"}>注册暂未开放，请联系站长</p>
        ) : (
          <>
            <form onSubmit={submit} className={"form flex flex-col [gap:12px] [&_label]:flex [&_label]:flex-col [&_label]:[gap:5px] [&_label]:[font-size:0.88rem] [&_label]:[color:var(--color-muted)]"}>
              <label>
                邮箱
                <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
              </label>
              <label>
                密码（至少 8 位）
                <Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              </label>
              <label>
                确认密码
                <Input type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
              </label>
              {inviteRequired && (
                <label>
                  邀请码
                  <Input required value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder="向站长索取" />
                </label>
              )}
              {codeRequired && !mailMissing && (
                <EmailCodeField email={email} purpose="register" value={code} onChange={setCode} disabled={register.isPending} onNeedLogin={onLogin ?? (() => void navigate('/login', { state: { from } }))} />
              )}
              {mailMissing && (
                <p className={"form-error [color:var(--color-danger)] [font-size:0.85rem] m-0"}>邮件服务尚未配置，暂时无法注册，请联系站长</p>
              )}
              {error && (
                <p role="alert" className={"form-error [color:var(--color-danger)] [font-size:0.85rem] m-0"}>
                  {error}
                  {emailTaken && (
                    <>
                      {' '}
                      {onLogin
                        ? <Button variant="plain" className="text-brand hover:underline" onClick={onLogin}>去登录</Button>
                        : <Link className="text-brand hover:underline" to="/login" state={{ from }}>去登录</Link>}
                    </>
                  )}
                </p>
              )}
              <Button variant="primary" type="submit" className={"btn-block w-full justify-center"} loading={register.isPending} disabled={mailMissing}>
                {register.isPending ? '注册中…' : '注册并登录'}
              </Button>
            </form>
            {config?.githubEnabled && (
              <>
                <div className={"auth-divider flex items-center [gap:10px] [margin:14px_0_10px] [font-size:0.82rem] [color:var(--color-muted)] [&::before]:[content:''] [&::before]:flex-1 [&::before]:[height:1px] [&::before]:[background:var(--color-border)] [&::after]:[content:''] [&::after]:flex-1 [&::after]:[height:1px] [&::after]:[background:var(--color-border)]"}>或</div>
                <a className={"btn [border:1px_solid_transparent] [border-radius:var(--radius)] [padding:8px_14px] [font-size:0.9rem] cursor-pointer [color:var(--color-text)] inline-flex items-center [gap:4px] [&:disabled]:[opacity:0.55] [&:disabled]:[cursor:not-allowed] btn-ghost [border-color:var(--color-border)] [background:var(--color-card)] [&:not(:disabled):hover]:[border-color:var(--color-primary)] [&:not(:disabled):hover]:[color:var(--color-primary)] btn-block w-full justify-center"} href="/api/auth/github">使用 GitHub 登录</a>
              </>
            )}
          </>
        )}
        <p className={"auth-switch [margin:16px_0_0] [font-size:0.88rem] [color:var(--color-muted)]"}>
          已有账号？{onLogin
            ? <Button variant="plain" className="text-sm text-brand hover:underline" disabled={register.isPending} onClick={onLogin}>直接登录</Button>
            : <Link to="/login" state={{ from }}>直接登录</Link>}
        </p>
      </div>
    </div>
  );
}
