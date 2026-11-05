// 邮件发信（10-18）：Resend API。
// 只用一个接口 POST /emails —— 验证码是固定格式纯文本，不值得引入模板系统或 SDK，原生 fetch 足够。
// 为什么要独立成模块：注册与找回密码共用；以后再加通知类邮件也只改这里。
import { env } from '../env';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10_000;

/** 发信失败统一用这个类型，路由层据此返回 502/503 而不是 500 */
export class EmailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailDeliveryError';
  }
}

const SUBJECTS = { register: '注册验证码', reset: '重置密码验证码' } as const;
const ACTIONS = { register: '注册', reset: '重置密码' } as const;

/**
 * 发送验证码邮件。
 * 只抛 EmailDeliveryError；上游错误信息里不含验证码本身，避免泄漏到日志。
 */
export async function sendVerificationEmail(
  to: string,
  code: string,
  purpose: keyof typeof SUBJECTS,
): Promise<void> {
  if (!env.email.resendApiKey) throw new EmailDeliveryError('邮件服务未配置');
  const text = [
    `你的${ACTIONS[purpose]}验证码是：${code}`,
    '',
    '10 分钟内有效，仅可使用一次。',
    '如果这不是你本人操作，请忽略这封邮件。',
  ].join('\n');

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.email.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: env.email.from, to: [to], subject: SUBJECTS[purpose], text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? '请求超时' : '网络错误';
    throw new EmailDeliveryError(`验证码邮件发送失败：${reason}`);
  }
  if (!response.ok) {
    // 只记状态码：Resend 的响应体可能回显收件地址，不进错误信息
    throw new EmailDeliveryError(`验证码邮件发送失败（发信服务返回 ${response.status}）`);
  }
}
