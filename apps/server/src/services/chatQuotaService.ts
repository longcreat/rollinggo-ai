// 日对话轮数额度：独立于生成配额（GEN_DAILY_LIMIT 按 generations.status='done' 计数，对话天然不计入）。
//
// 事实来源是 chat_messages 表当日 role='user' 的行数 —— 不新增计数表。
// 由于消息在理解成功后才成批落库，「失败/被拒的一轮不计数」自动成立。
import { and, eq, gte, sql } from 'drizzle-orm';
import { startOfToday, startOfTomorrow, type UsageView } from '@tripweaver/shared';
import { db } from '../db/client';
import { chatMessages } from '../db/schema';
import { env } from '../env';

/** 今日已消耗的对话轮数（一轮 = 一条用户消息） */
export async function chatTurnsToday(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.userId, userId),
        eq(chatMessages.role, 'user'),
        gte(chatMessages.createdAt, new Date(startOfToday())),
      ),
    );
  return Number(row?.n ?? 0);
}

export async function chatUsageView(userId: string): Promise<UsageView> {
  const used = await chatTurnsToday(userId);
  return {
    usedToday: used,
    dailyLimit: env.chatDailyLimit,
    remaining: Math.max(0, env.chatDailyLimit - used),
    resetAt: startOfTomorrow(),
  };
}

export async function chatHasQuota(userId: string): Promise<boolean> {
  return (await chatTurnsToday(userId)) < env.chatDailyLimit;
}
