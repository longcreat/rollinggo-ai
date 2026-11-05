import { useEffect, useState } from 'react';
import { EMAIL_MAX_LENGTH, EMAIL_PATTERN, type EmailCodePurpose } from '@tripweaver/shared';
import { ApiError } from '../api/client';
import { useSendEmailCode } from '../api/hooks';
import { Button } from './ui/Button';
import { Input } from './ui/Field';

/** 重发倒计时：与服务端 RESEND_INTERVAL_MS（60 秒）对齐 */
const COUNTDOWN_SECONDS = 60;

/** 邮箱格式校验（与后端 EmailSchema 共用同一正则）：返回中文提示，合法时返回 null */
export function checkEmail(raw: string): string | null {
  const value = raw.trim();
  if (!value) return '请先填写邮箱';
  if (/\s/.test(value)) return '邮箱不能包含空格';
  if (value.length > EMAIL_MAX_LENGTH) return `邮箱过长（最多 ${EMAIL_MAX_LENGTH} 字符）`;
  if (!new RegExp(EMAIL_PATTERN).test(value)) return '邮箱格式不正确，请检查后重试';
  return null;
}

/**
 * 邮箱验证码输入 + 获取按钮（10-18）。
 * 注册页与找回密码页共用；purpose 决定验证码用途，两种用途的码互不通用。
 */
export function EmailCodeField({ email, purpose, value, onChange, disabled, onNeedLogin }: {
  email: string;
  purpose: EmailCodePurpose;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** 邮箱已注册时出现「去登录」入口；不传则不显示（如找回密码页） */
  onNeedLogin?: () => void;
}) {
  const send = useSendEmailCode();
  const [seconds, setSeconds] = useState(0);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [taken, setTaken] = useState(false);

  useEffect(() => {
    if (seconds <= 0) return;
    const timer = setTimeout(() => setSeconds((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [seconds]);

  const request = () => {
    setError('');
    setNote('');
    setTaken(false);
    const target = email.trim();
    // 发码前先做应用层格式校验：只靠浏览器 type=email 会放行 a@b，落到后端才 400「请求参数不正确」
    const invalid = checkEmail(target);
    if (invalid) {
      setError(invalid);
      return;
    }
    send.mutate({ email: target, purpose }, {
      onSuccess: () => {
        setSeconds(COUNTDOWN_SECONDS);
        setNote('验证码已发送，请查收邮件（10 分钟内有效）');
      },
      onError: (err) => {
        setError(err.message);
        // 已注册邮箱：直接给出可操作入口，避免用户守在「验证码已发送」里等一封不会来的信
        if (err instanceof ApiError && err.status === 409 && purpose === 'register') setTaken(true);
      },
    });
  };

  const waiting = seconds > 0;
  return (
    <div className="flex flex-col [gap:5px] [font-size:0.88rem] [color:var(--color-muted)]">
      <label className="flex flex-col [gap:5px]">
        邮箱验证码
        <span className="flex items-center [gap:8px]">
          <Input
            className="min-w-0 flex-1"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            value={value}
            onChange={(event) => onChange(event.target.value.replace(/\D/g, ''))}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
          />
          <Button
            variant="secondary"
            type="button"
            className="shrink-0 whitespace-nowrap"
            disabled={disabled || waiting}
            onClick={request}
          >
            {send.isPending ? '发送中…' : waiting ? `${seconds}s 后重发` : '获取验证码'}
          </Button>
        </span>
      </label>
      {note && <p className="m-0 [font-size:0.82rem] text-brand">{note}</p>}
      {error && (
        <p role="alert" className="m-0 [font-size:0.82rem] [color:var(--color-danger)]">
          {error}
          {taken && onNeedLogin && (
            <>
              {' '}
              <Button
                variant="plain"
                className="[font-size:0.82rem] text-brand hover:underline"
                onClick={onNeedLogin}
              >
                去登录
              </Button>
            </>
          )}
        </p>
      )}
    </div>
  );
}
