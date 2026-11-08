// 生成任务的持久视图（对齐 openmuse 的 AgentTask）：开始即写 running 行，结束原地更新。
// 为什么复用 generations 而不是新表：配额、会话反查、用量统计都已依赖这张表；
// 新表会制造第三个事实源。所有写入按 (user_id, job_id) 幂等，重跑不会产生重复任务。
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { DataSourceKind, GenerateForm, GenerationJobStatus, GenerationWarning } from '@tripweaver/shared';
import { db } from '../db/client';
import { generations } from '../db/schema';
import type { GenerationAgentKey, GenerationTaskRef } from './provenance';

export interface GenerationTaskUsage {
  tokensIn: number;
  tokensOut: number;
  amapCalls: number;
  searchCalls: number;
}

export interface GenerationTaskDetails {
  destination?: string;
  days?: number;
  summary?: string;
  reviewNotes?: string[];
  dataSources?: DataSourceKind[];
  warnings?: GenerationWarning[];
  error?: string;
  usage?: GenerationTaskUsage;
  usedByok?: boolean;
}

export interface GenerationTaskView {
  jobId: string;
  status: GenerationJobStatus;
  tripId: string | null;
  destination?: string;
  days?: number;
  summary?: string;
  reviewNotes?: string[];
  dataSources?: DataSourceKind[];
  warnings?: GenerationWarning[];
  error?: string;
  conversationId?: string;
  /** 发起委派的主 Agent 回合 id（requestId）。 */
  parentTurnId?: string;
  /** durable task id：重启后取消仍能命中具体任务。 */
  durableTaskId?: string;
  /** 子 Agent key → durable conversation id：任务终态后子页面仍能读取流程。 */
  agentConversations?: Partial<Record<GenerationAgentKey, string>>;
  createdAt: number;
  finishedAt?: number;
}

type Row = typeof generations.$inferSelect;

export function toGenerationTaskView(row: Row): GenerationTaskView | null {
  if (!row.jobId) return null;
  return {
    jobId: row.jobId,
    status: row.status as GenerationJobStatus,
    tripId: row.tripId,
    ...(row.destination ? { destination: row.destination } : {}),
    ...(row.days !== null ? { days: row.days } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.reviewNotes?.length ? { reviewNotes: row.reviewNotes } : {}),
    ...(row.dataSources?.length ? { dataSources: row.dataSources } : {}),
    ...(row.warnings?.length ? { warnings: row.warnings } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.conversationId ? { conversationId: row.conversationId } : {}),
    ...(row.parentTurnId ? { parentTurnId: row.parentTurnId } : {}),
    ...(row.durableTaskId ? { durableTaskId: row.durableTaskId } : {}),
    ...(row.agentConversations ? { agentConversations: row.agentConversations } : {}),
    createdAt: row.createdAt.getTime(),
    ...(row.finishedAt ? { finishedAt: row.finishedAt.getTime() } : {}),
  };
}

/** 任务开始：先落 running 行，重启/刷新后仍能发现「有一份生成在跑」。 */
export async function beginGenerationTask(ref: GenerationTaskRef, form: GenerateForm, requestId?: string): Promise<void> {
  await db.insert(generations).values({
    id: ref.jobId,
    userId: ref.userId,
    jobId: ref.jobId,
    requestId: requestId ?? null,
    parentTurnId: ref.provenance.parentTurnId ?? null,
    conversationId: ref.provenance.conversationId ?? null,
    kind: ref.provenance.kind,
    targetTripId: ref.provenance.targetTripId ?? null,
    destination: form.destination,
    days: form.days,
    status: 'running',
    usedXhs: false,
    usedByok: false,
    createdAt: new Date(ref.createdAt),
  }).onConflictDoUpdate({
    target: [generations.userId, generations.jobId],
    set: { status: 'running', ...(requestId ? { requestId } : {}) },
  });
}

/** 任务终态：连同摘要、软告警与用量一起原地更新（成功路径在行程事务内调用）。 */
export async function finalizeGenerationTask(
  ref: GenerationTaskRef,
  status: Exclude<GenerationJobStatus, 'running'>,
  tripId: string | null,
  details: GenerationTaskDetails = {},
  writer: Pick<typeof db, 'insert'> = db,
): Promise<void> {
  const finishedAt = new Date();
  await writer.insert(generations).values({
    id: ref.jobId,
    userId: ref.userId,
    jobId: ref.jobId,
    conversationId: ref.provenance.conversationId ?? null,
    parentTurnId: ref.provenance.parentTurnId ?? null,
    kind: ref.provenance.kind,
    targetTripId: ref.provenance.targetTripId ?? null,
    destination: details.destination ?? null,
    days: details.days ?? null,
    status,
    tripId,
    finishedAt,
    error: details.error ?? null,
    summary: details.summary ?? null,
    reviewNotes: details.reviewNotes ?? null,
    dataSources: details.dataSources ?? null,
    warnings: details.warnings ?? null,
    usedXhs: false,
    usedByok: details.usedByok ?? false,
    tokensIn: details.usage?.tokensIn ?? 0,
    tokensOut: details.usage?.tokensOut ?? 0,
    amapCalls: details.usage?.amapCalls ?? 0,
    searchCalls: details.usage?.searchCalls ?? 0,
    createdAt: new Date(ref.createdAt),
  }).onConflictDoUpdate({
    target: [generations.userId, generations.jobId],
    set: {
      status,
      tripId,
      finishedAt,
      error: details.error ?? null,
      summary: details.summary ?? null,
      reviewNotes: details.reviewNotes ?? null,
      dataSources: details.dataSources ?? null,
      warnings: details.warnings ?? null,
      usedByok: details.usedByok ?? false,
      tokensIn: details.usage?.tokensIn ?? 0,
      tokensOut: details.usage?.tokensOut ?? 0,
      amapCalls: details.usage?.amapCalls ?? 0,
      searchCalls: details.usage?.searchCalls ?? 0,
      ...(ref.provenance.parentTurnId ? { parentTurnId: ref.provenance.parentTurnId } : {}),
    },
  });
}

export async function getGenerationTask(userId: string, jobId: string): Promise<GenerationTaskView | null> {
  const [row] = await db.select().from(generations)
    .where(and(eq(generations.userId, userId), eq(generations.jobId, jobId)))
    .limit(1);
  return row ? toGenerationTaskView(row) : null;
}

/** 当前运行中的任务（持久层判定并发闸门的唯一依据）。 */
export async function getRunningGenerationTask(userId: string): Promise<GenerationTaskView | null> {
  const [row] = await db.select().from(generations)
    .where(and(eq(generations.userId, userId), eq(generations.status, 'running'), isNotNull(generations.jobId)))
    .orderBy(desc(generations.createdAt))
    .limit(1);
  return row ? toGenerationTaskView(row) : null;
}

/** 运行中且未超时的任务；超时行顺手标 error，避免永久占用运行闸门。 */
export async function findActiveRunningTask(userId: string, staleAfterMs: number): Promise<GenerationTaskView | null> {
  const task = await getRunningGenerationTask(userId);
  if (!task) return null;
  if (Date.now() - task.createdAt > staleAfterMs) {
    await markGenerationTaskFailed(userId, task.jobId, '任务已中断，请重新生成').catch(() => {});
    return null;
  }
  return task;
}

export async function setGenerationDurableTaskId(userId: string, jobId: string, durableTaskId: string): Promise<void> {
  await db.update(generations)
    .set({ durableTaskId })
    .where(and(eq(generations.userId, userId), eq(generations.jobId, jobId)));
}

/** 子 Agent 创建会话后登记；JSONB 合并，终态行保留映射。 */
export async function setGenerationAgentConversation(
  userId: string,
  jobId: string,
  key: GenerationAgentKey,
  conversationId: string,
): Promise<void> {
  await db.update(generations).set({
    agentConversations: sql`coalesce(${generations.agentConversations}, '{}'::jsonb)
      || jsonb_build_object(${key}::text, ${conversationId}::text)`,
  }).where(and(eq(generations.userId, userId), eq(generations.jobId, jobId)));
}

export async function getLatestGenerationTask(userId: string): Promise<GenerationTaskView | null> {
  const [row] = await db.select().from(generations)
    .where(and(eq(generations.userId, userId), isNotNull(generations.jobId)))
    .orderBy(desc(generations.createdAt))
    .limit(1);
  return row ? toGenerationTaskView(row) : null;
}

/** 中断兜底：只有持久行、没有内存任务且已超时，才把 running 改成 error。 */
export async function markGenerationTaskFailed(userId: string, jobId: string, message: string): Promise<void> {
  await db.update(generations)
    .set({ status: 'error', error: message, finishedAt: new Date() })
    .where(and(eq(generations.userId, userId), eq(generations.jobId, jobId), eq(generations.status, 'running')));
}

export async function getTaskByRequestId(userId: string, requestId: string): Promise<GenerationTaskView | null> {
  const [row] = await db.select().from(generations)
    .where(and(eq(generations.userId, userId), eq(generations.requestId, requestId)))
    .limit(1);
  return row ? toGenerationTaskView(row) : null;
}
