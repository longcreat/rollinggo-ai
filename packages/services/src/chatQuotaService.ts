// 日对话轮数额度：独立于生成配额（GEN_DAILY_LIMIT 按 generations.status='done' 计数，对话天然不计入）。
//
// 事实来源是 chat_messages 表当日 role='user' 的行数 —— 不新增计数表。
// 由于消息在理解成功后才成批落库，「失败/被拒的一轮不计数」自动成立。
import { and, eq, gte, sql } from 'drizzle-orm';
import { startOfToday, startOfTomorrow, type UsageView } from '@rollinggo-trip/shared';
import { db } from '@rollinggo-trip/core/db/client';
import { chatMessages } from '@rollinggo-trip/core/db/schema';
import { env } from '@rollinggo-trip/core/env';

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

/**
 * 对话额度闸门：2026-11-07 定调「测试环境不限量」，恒可用；chatTurnsToday/chatUsageView 仍供 /api/usage 展示。
 * 生产恢复点：恢复原判定 `(await chatTurnsToday(userId)) < env.chatDailyLimit`。
 */
export async function chatHasQuota(_userId: string): Promise<boolean> {
  void _userId;
  return true;
}
