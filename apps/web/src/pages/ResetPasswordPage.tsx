import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePasswordReset } from '../api/hooks';
import { EmailCodeField } from '../components/EmailCodeField';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Field';

/**
 * 找回密码（10-18）：邮箱 + 验证码 + 新密码。
 * 重置成功会作废该用户全部会话，所以这里不自动登录，引导回登录页。
 */
export function ResetPasswordPage({ embedded = false, onBack }: {
  embedded?: boolean;
  onBack?: () => void;
}) {
  const reset = usePasswordReset();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const back = () => {
    if (onBack) return onBack();
    void navigate('/login', { replace: true });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    if (code.length !== 6) {
      setError('请输入 6 位邮箱验证码');
      return;
    }
    setError('');
    reset.mutate({ email, code, password }, {
      onSuccess: () => setDone(true),
      onError: (err) => setError(err.message),
    });
  };

  const cardClass = embedded
    ? 'auth-card w-full'
    : 'auth-card w-full [max-width:380px] [background:var(--color-card)] [border:1px_solid_var(--color-border)] [border-radius:14px] [box-shadow:var(--shadow)] [padding:28px_24px] [&_.brand]:[font-size:1.4rem]';

  if (done) {
    return (
      <div className={embedded ? 'auth-page' : 'auth-page min-h-dvh flex items-center justify-center px-4 py-6'}>
        <div className={cardClass}>
          <p className="m-0 text-sm leading-6 text-ink">密码已重置，请用新密码重新登录。</p>
          <Button variant="primary" type="button" className="btn-block mt-4 w-full justify-center" onClick={back}>返回登录</Button>
        </div>
      </div>
    );
  }

  return (
    <div className={embedded ? 'auth-page' : 'auth-page min-h-dvh flex items-center justify-center px-4 py-6'}>
      <div className={cardClass}>
        <form onSubmit={submit} className={'form flex flex-col [gap:12px] [&_label]:flex [&_label]:flex-col [&_label]:[gap:5px] [&_label]:[font-size:0.88rem] [&_label]:[color:var(--color-muted)]'}>
          <label>
            邮箱
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </label>
          <EmailCodeField email={email} purpose="reset" value={code} onChange={setCode} disabled={reset.isPending} />
          <label>
            新密码（至少 8 位）
            <Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </label>
          <label>
            确认新密码
            <Input type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </label>
          {error && <p role="alert" className={'form-error [color:var(--color-danger)] [font-size:0.85rem] m-0'}>{error}</p>}
          <Button variant="primary" type="submit" className={'btn-block w-full justify-center'} loading={reset.isPending}>
            {reset.isPending ? '重置中…' : '重置密码'}
          </Button>
        </form>
        <p className={'auth-switch [margin:16px_0_0] [font-size:0.88rem] [color:var(--color-muted)]'}>
          想起密码了？<Button variant="plain" className="text-sm text-brand hover:underline" onClick={back}>返回登录</Button>
        </p>
      </div>
    </div>
  );
}
