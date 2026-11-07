// HITL 问答持久化：记录问题与回答，供重启后审计与「孤儿问题」收口。
// 进程内的 Promise 仍然只在当前回合有效；重启后的 pending 行统一标 expired。
import { and, desc, eq } from 'drizzle-orm';
import type { AgentQuestion, AgentQuestionAnswer } from '@tripweaver/shared';
import { db } from '../../db/client';
import { agentQuestions } from '../../db/schema';

export type StoredQuestionStatus = 'pending' | 'answered' | 'expired';

export interface StoredQuestion {
  id: string;
  status: StoredQuestionStatus;
  questions: AgentQuestion[];
  answers?: AgentQuestionAnswer[];
}

export async function recordQuestion(input: {
  id: string;
  userId: string;
  conversationId: string;
  requestId: string;
  questions: AgentQuestion[];
  createdAt: number;
  expiresAt: number;
}): Promise<void> {
  await db.insert(agentQuestions).values({
    id: input.id,
    userId: input.userId,
    conversationId: input.conversationId,
    requestId: input.requestId,
    questions: input.questions,
    status: 'pending',
    expiresAt: new Date(input.expiresAt),
    createdAt: new Date(input.createdAt),
  }).onConflictDoNothing();
}

export async function markQuestionAnswered(
  userId: string,
  questionId: string,
  answers: AgentQuestionAnswer[],
): Promise<void> {
  await db.update(agentQuestions)
    .set({ status: 'answered', answers, answeredAt: new Date() })
    .where(and(eq(agentQuestions.userId, userId), eq(agentQuestions.id, questionId), eq(agentQuestions.status, 'pending')));
}

export async function markQuestionExpired(userId: string, questionId: string): Promise<void> {
  await db.update(agentQuestions)
    .set({ status: 'expired', answeredAt: new Date() })
    .where(and(eq(agentQuestions.userId, userId), eq(agentQuestions.id, questionId), eq(agentQuestions.status, 'pending')));
}

export async function getQuestion(userId: string, conversationId: string, questionId: string): Promise<StoredQuestion | null> {
  const [row] = await db.select().from(agentQuestions)
    .where(and(
      eq(agentQuestions.userId, userId),
      eq(agentQuestions.conversationId, conversationId),
      eq(agentQuestions.id, questionId),
    ))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    status: row.status as StoredQuestionStatus,
    questions: row.questions,
    ...(row.answers ? { answers: row.answers } : {}),
  };
}

export async function latestQuestionForConversation(userId: string, conversationId: string): Promise<StoredQuestion | null> {
  const [row] = await db.select().from(agentQuestions)
    .where(and(eq(agentQuestions.userId, userId), eq(agentQuestions.conversationId, conversationId)))
    .orderBy(desc(agentQuestions.createdAt))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    status: row.status as StoredQuestionStatus,
    questions: row.questions,
    ...(row.answers ? { answers: row.answers } : {}),
  };
}

/** 重启后没有等待者：把该会话遗留的 pending 行标 expired，避免前端反复拿到答不上的问题。 */
export async function expireConversationQuestions(userId: string, conversationId: string): Promise<void> {
  await db.update(agentQuestions)
    .set({ status: 'expired', answeredAt: new Date() })
    .where(and(
      eq(agentQuestions.userId, userId),
      eq(agentQuestions.conversationId, conversationId),
      eq(agentQuestions.status, 'pending'),
    ));
}

/** 进程启动时调用：上一个进程留下的 pending 问题不可能再被回答。 */
export async function expireOrphanQuestions(): Promise<number> {
  const rows = await db.update(agentQuestions)
    .set({ status: 'expired', answeredAt: new Date() })
    .where(eq(agentQuestions.status, 'pending'))
    .returning({ id: agentQuestions.id });
  return rows.length;
}
