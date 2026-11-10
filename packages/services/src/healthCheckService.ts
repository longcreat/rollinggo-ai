// 行程体检（Pass 1a 确定性审计）：feasibility 全量规则 + 远郊混排检测 → 结构化 Finding。
//
// 零 LLM、零外呼：纯函数 + trip 数据输入。发现即建议（suggestionFromViolation），
// 建议的执行与验证在 healthRepair（Pass 2）。体检会话落库（trip_health_checks），
// 同一 trip 版本的最近一次体检可直接复用（不重复跑）。
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@rollinggo-trip/core/db/client';
import { tripHealthChecks, trips } from '@rollinggo-trip/core/db/schema';
import { uid, type Trip } from '@rollinggo-trip/shared';
import type { HealthFinding, HealthCheckView, HealthDecision } from '@rollinggo-trip/shared';

/** 行程的当前 DB 版本号（Trip JSON 不带 version，体检的乐观锁需要它） */
export async function getTripVersion(userId: string, tripId: string): Promise<number | null> {
  const [row] = await db.select({ version: trips.version }).from(trips)
    .where(and(eq(trips.id, tripId), eq(trips.userId, userId)));
  return row?.version ?? null;
}
import { auditTrip } from './healthAudit';
import { applyHealthDecisions } from './healthRepairService';

// ---------- 会话管理 ----------

function rowToView(row: typeof tripHealthChecks.$inferSelect): HealthCheckView {
  return {
    id: row.id,
    tripId: row.tripId,
    tripVersion: row.tripVersion,
    status: row.status as HealthCheckView['status'],
    findings: (row.findings as HealthFinding[]) ?? [],
    createdAt: row.createdAt.getTime(),
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt.getTime() } : {}),
    ...((row.result as HealthCheckView['result']) ? { result: row.result as HealthCheckView['result'] } : {}),
  };
}

/** 创建体检（或复用同版本未处置的旧体检）。Pass 1a 同步完成。@param version 行程当前 DB 版本 */
export async function createHealthCheck(userId: string, trip: Trip, version: number): Promise<HealthCheckView> {
  // 同一 trip（id+version）已有 pending 体检 → 直接复用（幂等）
  const existing = await db.select().from(tripHealthChecks)
    .where(and(
      eq(tripHealthChecks.userId, userId),
      eq(tripHealthChecks.tripId, trip.id),
      eq(tripHealthChecks.status, 'pending'),
    ))
    .orderBy(desc(tripHealthChecks.createdAt))
    .limit(1);
  if (existing[0] && existing[0].tripVersion === version) return rowToView(existing[0]);

  // 旧 pending 体检版本不符 → 过期掉
  for (const stale of existing) {
    if (stale.tripVersion !== version) {
      await db.update(tripHealthChecks).set({ status: 'expired' })
        .where(and(eq(tripHealthChecks.id, stale.id), eq(tripHealthChecks.userId, userId)));
    }
  }

  const { findings } = auditTrip(trip);
  const id = uid();
  await db.insert(tripHealthChecks).values({
    id, userId, tripId: trip.id, tripVersion: version,
    status: 'pending', findings, createdAt: new Date(),
  });
  return {
    id, tripId: trip.id, tripVersion: version, status: 'pending',
    findings, createdAt: Date.now(),
  };
}

export async function getHealthCheck(userId: string, checkId: string): Promise<HealthCheckView | null> {
  const [row] = await db.select().from(tripHealthChecks)
    .where(and(eq(tripHealthChecks.id, checkId), eq(tripHealthChecks.userId, userId)));
  return row ? rowToView(row) : null;
}

/** 最近一次体检（前端徽章用）：pending 优先，其次 completed */
export async function latestHealthCheck(userId: string, tripId: string): Promise<HealthCheckView | null> {
  const rows = await db.select().from(tripHealthChecks)
    .where(and(eq(tripHealthChecks.userId, userId), eq(tripHealthChecks.tripId, tripId)))
    .orderBy(desc(tripHealthChecks.createdAt))
    .limit(5);
  return rows.find((r) => r.status === 'pending') ? rowToView(rows.find((r) => r.status === 'pending')!) : rows[0] ? rowToView(rows[0]) : null;
}

/** 提交处置 → Pass 2 重排 → 落新版本 → 标记完成 */
export async function resolveHealthCheck(options: {
  userId: string;
  checkId: string;
  trip: Trip;
  decisions: HealthDecision[];
  updatedAt: number;
  signal: AbortSignal;
}): Promise<HealthCheckView> {
  const { userId, checkId, trip, decisions, updatedAt, signal } = options;
  const check = await getHealthCheck(userId, checkId);
  if (!check) throw Object.assign(new Error('体检会话不存在'), { statusCode: 404 });
  if (check.status !== 'pending') throw Object.assign(new Error('该体检已处理过'), { statusCode: 409 });
  const version = await getTripVersion(userId, trip.id);
  if (check.tripId !== trip.id || version === null || check.tripVersion !== version) {
    throw Object.assign(new Error('行程已更新，请重新体检'), { statusCode: 409 });
  }

  // Pass 2：确定性执行 accept 的建议（每步验证，不过回滚）
  const outcome = await applyHealthDecisions(trip, check.findings, decisions, signal);

  let result: HealthCheckView['result'];
  let view: HealthCheckView;
  if (outcome) {
    // 落新版本（复用 detailChat 的提交链路：版本 + 幂等）
    const { commitOperation } = await import('./detailOperationService');
    const { createTrip, assertLatestTrip } = await import('./tripService');
    const { repairChangedRoutes } = await import('./tripHistoryService');
    const fingerprint = `health:${checkId}`;
    await repairChangedRoutes(userId, trip, outcome.trip, signal);
    const committed = await commitOperation(userId, `health-${checkId}`, fingerprint, async (tx) => {
      const latest = await assertLatestTrip(userId, trip.id, updatedAt, tx);
      const saved = await createTrip(userId, outcome.trip, trip.id, tx);
      await tx.update((await import('@rollinggo-trip/core/db/schema')).trips)
        .set({ changeSummary: `体检修复：${outcome.applied.join('；').slice(0, 150)}` })
        .where(and(eq((await import('@rollinggo-trip/core/db/schema')).trips.id, saved.id), eq((await import('@rollinggo-trip/core/db/schema')).trips.userId, userId)));
      result = {
        version: latest.version + 1,
        tripId: saved.id,
        applied: outcome.applied,
        skipped: outcome.skipped,
      };
      return result;
    });
    result = committed as HealthCheckView['result'];
  } else {
    result = { version: check.tripVersion, tripId: trip.id, applied: [], skipped: decisions.length };
  }

  await db.update(tripHealthChecks)
    .set({ status: 'completed', decisions, result, resolvedAt: new Date() })
    .where(and(eq(tripHealthChecks.id, checkId), eq(tripHealthChecks.userId, userId)));
  view = (await getHealthCheck(userId, checkId))!;
  return view;
}
