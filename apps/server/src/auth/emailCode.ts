// 邮箱验证码（10-18）：注册与找回密码共用。
// 设计要点（见任务 prd.md）：
//   · 只存 bcrypt 哈希，明文只出现在发信内容里
//   · 同一 (email, purpose) 只认最新一条未消费记录；消费后不可复用
//   · 用途隔离：注册码不能拿去重置密码，反之亦然
//   · 频控三道：同邮箱 60 秒重发间隔、同邮箱每小时 5 次、路由层再叠 IP 限流
import { randomInt } from 'node:crypto';
import { and, desc, eq, gte, isNull } from 'drizzle-orm';import { uid } from '@tripweaver/shared';
import { db } from '../db/client';
import { emailVerificationCodes } from '../db/schema';
import { hashPassword, verifyPassword } from './password';
import { sendVerificationEmail } from '../integrations/resend';

export type EmailCodePurpose = 'register' | 'reset';

export const CODE_TTL_MS = 10 * 60_000;
export const RESEND_INTERVAL_MS = 60_000;
export const HOURLY_LIMIT = 5;
export const MAX_ATTEMPTS = 5;

/** 验证码业务失败：status 直接给到路由层，避免各处重复映射 */
export class EmailCodeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'EmailCodeError';
  }
}

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * 生成并发送验证码。调用方负责事先判定「该不该发」（例如已注册邮箱的注册码请求静默跳过），
 * 本函数只管频控、落库、发信；发信失败会撤掉刚插入的记录，避免用户收不到信还被锁 60 秒。
 */
export async function issueEmailCode(email: string, purpose: EmailCodePurpose): Promise<void> {
  const now = new Date();
  const [latest] = await db
    .select({ createdAt: emailVerificationCodes.createdAt })
    .from(emailVerificationCodes)
    .where(and(eq(emailVerificationCodes.email, email), eq(emailVerificationCodes.purpose, purpose)))
    .orderBy(desc(emailVerificationCodes.createdAt))
    .limit(1);
  if (latest && now.getTime() - latest.createdAt.getTime() < RESEND_INTERVAL_MS) {
    throw new EmailCodeError('验证码发送过于频繁，请 60 秒后再试', 429);
  }

  const hourAgo = new Date(now.getTime() - 3600_000);
  const recent = await db
    .select({ id: emailVerificationCodes.id })
    .from(emailVerificationCodes)
    .where(and(eq(emailVerificationCodes.email, email), gte(emailVerificationCodes.createdAt, hourAgo)));
  if (recent.length >= HOURLY_LIMIT) {
    throw new EmailCodeError('该邮箱获取验证码次数过多，请稍后再试', 429);
  }

  const id = uid();
  const code = generateCode();
  await db.insert(emailVerificationCodes).values({
    id,
    email,
    purpose,
    codeHash: await hashPassword(code),
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    createdAt: now,
  });
  try {
    await sendVerificationEmail(email, code, purpose);
  } catch (err) {
    await db.delete(emailVerificationCodes).where(eq(emailVerificationCodes.id, id));
    throw err;
  }
}

/**
 * 校验并消费验证码。失败返回 false（不区分「不存在 / 过期 / 用尽 / 不匹配」，
 * 统一文案避免给攻击者试探信号）；成功即写入 consumedAt，同一码不可二次使用。
 */
export async function consumeEmailCode(email: string, purpose: EmailCodePurpose, code: string): Promise<boolean> {
  const [row] = await db
    .select()
    .from(emailVerificationCodes)
    .where(and(
      eq(emailVerificationCodes.email, email),
      eq(emailVerificationCodes.purpose, purpose),
      isNull(emailVerificationCodes.consumedAt),
    ))
    .orderBy(desc(emailVerificationCodes.createdAt))
    .limit(1);
  if (!row) return false;
  if (row.expiresAt.getTime() <= Date.now() || row.attempts >= MAX_ATTEMPTS) return false;

  const matched = await verifyPassword(code, row.codeHash);
  if (!matched) {
    // 试错次数满额后这条记录直接作废（attempts 到达上限，后续校验一律失败），必须重新获取
    await db
      .update(emailVerificationCodes)
      .set({ attempts: row.attempts + 1 })
      .where(eq(emailVerificationCodes.id, row.id));
    return false;
  }
  await db
    .update(emailVerificationCodes)
    .set({ consumedAt: new Date() })
    .where(eq(emailVerificationCodes.id, row.id));
  return true;
}
