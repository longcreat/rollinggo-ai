import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { detailOperations } from '../db/schema';
import { lockTripWriter, type TripWriter } from './tripService';

export const operationFingerprint = (kind: string, input: unknown) => createHash('sha256').update(JSON.stringify([kind, input])).digest('hex');

export async function readOperation(userId: string, id: string, fingerprint?: string, writer: TripWriter = db): Promise<unknown | null> {
  const [row] = await writer.select().from(detailOperations).where(and(eq(detailOperations.userId, userId), eq(detailOperations.id, id)));
  if (row && fingerprint && row.fingerprint !== fingerprint) throw Object.assign(new Error('操作标识已用于其他请求，请重新操作'), { statusCode: 409 });
  return row?.result ?? null;
}

export async function commitOperation<T>(userId: string, id: string, fingerprint: string, work: (tx: TripWriter) => Promise<T>): Promise<unknown> {
  return db.transaction(async (tx) => {
    await lockTripWriter(userId, tx);
    const previous = await readOperation(userId, id, fingerprint, tx);
    if (previous) return previous;
    const result = await work(tx);
    await tx.insert(detailOperations).values({ userId, id, fingerprint, result, createdAt: new Date() });
    return result;
  });
}

// 与现有生成运行器相同：单实例在途锁；持久化幂等仍由数据库事务保障。
const active = new Map<string, AbortController>();
const stopped = new Map<string, number>();
export function startDetailTurn(userId: string, conversationId: string, requestId: string) {
  const key = `${userId}:${conversationId}`;
  if (active.has(key)) throw Object.assign(new Error('当前对话仍在处理中，请稍后重试'), { statusCode: 409 });
  const controller = new AbortController();
  const requestKey = `${key}:${requestId}`;
  if ((stopped.get(requestKey) ?? 0) > Date.now()) controller.abort();
  stopped.delete(requestKey);
  active.set(key, controller);
  active.set(`${key}:${requestId}`, controller);
  return { controller, release: () => { active.delete(key); active.delete(`${key}:${requestId}`); } };
}
export function stopDetailTurn(userId: string, conversationId: string, requestId: string) {
  const key = `${userId}:${conversationId}:${requestId}`;
  const controller = active.get(key);
  if (controller) controller.abort();
  else {
    for (const [id, expires] of stopped) if (expires < Date.now()) stopped.delete(id);
    if (stopped.size >= 1000) stopped.delete(stopped.keys().next().value!);
    stopped.set(key, Date.now() + 120_000);
  }
}
