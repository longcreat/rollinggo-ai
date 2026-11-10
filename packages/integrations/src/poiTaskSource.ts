// POI 源的任务级上限包装（provider 中立，09-25 从 amap/poiSource.ts 抽出）：
// 每次生成最多 POI_MAX_PER_TASK 次搜索，超出后不发请求，直接回空数组。
// 抽出的理由同 nullPoiSource.ts —— 上限属于「生成任务的预算」而不是某家服务商的特性。
//
// 2026-11-07：调研 / 片区检索 / 补餐走的是不同用途、不同额度的检索，但**记账必须共用同一份统计**，
// 否则 amapCalls 少计、dataSources 漏标。因此 stats 可注入；上限按用途各自计数（maxCalls）。
import type { PoiSource } from './geoContracts';

/** 单次生成的 POI 搜索调用上限（对当前生效的服务商统一生效） */
export const POI_MAX_PER_TASK = 8;

export interface TaskPoiStats {
  calls: number;
  gotResults: boolean;
}

export interface TaskPoiSource {
  source: PoiSource;
  stats: TaskPoiStats;
}

export function createTaskPoiSource(
  inner: PoiSource,
  options: { stats?: TaskPoiStats; maxCalls?: number } = {},
): TaskPoiSource {
  const stats = options.stats ?? { calls: 0, gotResults: false };
  const maxCalls = options.maxCalls ?? POI_MAX_PER_TASK;
  let ownCalls = 0;
  const source: PoiSource = {
    kind: inner.kind,
    async searchPois(category, keyword, region, signal) {
      signal?.throwIfAborted();
      if (inner.kind === 'null') return [];                  // Null 源不计数，不烧日额度
      if (ownCalls >= maxCalls) return [];
      ownCalls += 1;
      stats.calls += 1;
      const pois = await inner.searchPois(category, keyword, region, signal);
      if (pois.length) stats.gotResults = true;
      return pois;
    },
    selfCheck: () => inner.selfCheck(),
  };
  return { source, stats };
}

/**
 * 非 PoiSource 形态的检索（如高德片区面状检索）也要计入同一本账：
 * 调用方在真正外呼前 `await gate(() => realCall())`；超过本用途额度直接回空数组。
 */
export function createTaskPoiGate(
  stats: TaskPoiStats,
  maxCalls: number = POI_MAX_PER_TASK,
): <T>(run: () => Promise<T[]>) => Promise<T[]> {
  let ownCalls = 0;
  return async <T>(run: () => Promise<T[]>): Promise<T[]> => {
    if (ownCalls >= maxCalls) return [];
    ownCalls += 1;
    stats.calls += 1;
    const result = await run();
    if (result.length) stats.gotResults = true;
    return result;
  };
}