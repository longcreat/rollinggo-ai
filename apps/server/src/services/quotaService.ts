import { and, eq, gte, sql } from 'drizzle-orm';
import { startOfToday, startOfTomorrow, type UsageView } from '@tripweaver/shared';
import { db } from '../db/client';
import { editorGeoUsage, generations } from '../db/schema';
import { env } from '../env';
import { amapQuotaLedger } from './amapQuotaService';

/** 今日已成功生成次数（失败/取消不计，PRD F8） */
export async function usedToday(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(generations)
    .where(
      and(
        eq(generations.userId, userId),
        eq(generations.status, 'done'),
        gte(generations.createdAt, new Date(startOfToday())),
      ),
    );
  return Number(row?.n ?? 0);
}

export async function usageView(userId: string): Promise<UsageView> {
  const used = await usedToday(userId);
  return {
    usedToday: used,
    dailyLimit: env.genDailyLimit,
    remaining: Math.max(0, env.genDailyLimit - used),
    resetAt: startOfTomorrow(),
  };
}

export async function hasQuota(userId: string): Promise<boolean> {
  return (await usedToday(userId)) < env.genDailyLimit;
}

// ---------- 全站外部数据源日额度（架构 §6） ----------
// 以 generations 用量列聚合为准（含 error/cancelled——外呼已实际发生），60s 内存缓存。
// 运行中任务的调用未入库，并发下有界超额（≤ 并发任务数 × 单任务上限），KISS 取舍已记录于任务 PRD。

const dailyAgg: Record<MeteredSource, { at: number; total: number }> = {
  amap: { at: 0, total: 0 },
  search: { at: 0, total: 0 },
};

type MeteredSource = 'amap' | 'search';

async function callsToday(key: MeteredSource): Promise<number> {
  const agg = dailyAgg[key];
  if (Date.now() - agg.at > 60_000) {
    const column = key === 'amap' ? generations.amapCalls : generations.searchCalls;
    const [row] = await db
      .select({ n: sql<number>`coalesce(sum(${column}), 0)` })
      .from(generations)
      .where(gte(generations.createdAt, new Date(startOfToday())));
    agg.total = Number(row?.n ?? 0);
    agg.at = Date.now();
  }
  return agg.total;
}

export async function amapBudgetRemaining(): Promise<number> {
  return amapQuotaLedger.remaining();
}

/** 高德 place（POI 搜索）当日剩余额度 —— 供 orchestrator 的 POI 源闸门使用 */
export async function amapPlaceBudgetRemaining(): Promise<number> {
  return amapQuotaLedger.remainingOf('place');
}

async function editorCallsToday(source: MeteredSource): Promise<number> {
  const [row] = await db.select().from(editorGeoUsage).where(and(
    eq(editorGeoUsage.day, String(startOfToday())), eq(editorGeoUsage.source, source),
  ));
  return row?.calls ?? 0;
}

/** Atomically reserve editor calls; unused calls are refunded, including pre-request skips.
 * Reservations survive crashes conservatively. Generation concurrency retains its existing
 * approximate budget semantics; editor reservations themselves cannot overspend the snapshot. */
export async function reserveEditorGeoBudget(source: 'search', count: number) {
  const day = String(startOfToday());
  const limit = env.searchDailyBudget - await callsToday(source);
  if (limit < count) return null;
  const rows = await db.insert(editorGeoUsage).values({ day, source, calls: count })
    .onConflictDoUpdate({ target: [editorGeoUsage.day, editorGeoUsage.source],
      set: { calls: sql`${editorGeoUsage.calls} + ${count}` },
      setWhere: sql`${editorGeoUsage.calls} + ${count} <= ${limit}`,
    }).returning();
  if (!rows.length) return null;
  return async (used: number) => {
    if (!Number.isInteger(used) || used < 0 || used > count) throw new Error('Invalid route call accounting');
    await db.update(editorGeoUsage).set({ calls: sql`${editorGeoUsage.calls} - ${count - used}` })
      .where(and(eq(editorGeoUsage.day, day), eq(editorGeoUsage.source, source)));
  };
}

export async function searchBudgetRemaining(): Promise<number> {
  return Math.max(0, env.searchDailyBudget - (await callsToday('search')) - (await editorCallsToday('search')));
}
