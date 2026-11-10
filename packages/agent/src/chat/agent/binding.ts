// 业务会话 ↔ durable 会话的绑定：详情对话与行前回合共用。
import { and, eq } from 'drizzle-orm';
import { db } from '@rollinggo-trip/core/db/client';
import { agentConversations } from '@rollinggo-trip/core/db/schema';

export async function readBinding(userId: string, conversationId: string): Promise<number | null> {
  const [row] = await db.select({ durableId: agentConversations.durableId })
    .from(agentConversations)
    .where(and(eq(agentConversations.userId, userId), eq(agentConversations.conversationId, conversationId)));
  return row?.durableId ?? null;
}

export async function saveBinding(userId: string, conversationId: string, durableId: number): Promise<void> {
  await db.insert(agentConversations)
    .values({ userId, conversationId, durableId, createdAt: new Date() })
    .onConflictDoNothing();
}
