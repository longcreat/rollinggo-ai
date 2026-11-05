// POI 源的任务级上限包装（provider 中立，09-25 从 amap/poiSource.ts 抽出）：
// 每次生成最多 POI_MAX_PER_TASK 次搜索，超出后不发请求，直接回空数组。
// 抽出的理由同 nullPoiSource.ts —— 上限属于「生成任务的预算」而不是某家服务商的特性。
import type { PoiSource } from './geoContracts';

/** 单次生成的 POI 搜索调用上限（对当前生效的服务商统一生效） */
export const POI_MAX_PER_TASK = 8;

export interface TaskPoiSource {
  source: PoiSource;
  stats: { calls: number; gotResults: boolean };
}

export function createTaskPoiSource(inner: PoiSource): TaskPoiSource {
  const stats = { calls: 0, gotResults: false };
  const source: PoiSource = {
    kind: inner.kind,
    async searchPois(category, keyword, region, signal) {
      signal?.throwIfAborted();
      if (inner.kind === 'null') return [];                  // Null 源不计数，不烧日额度
      if (stats.calls >= POI_MAX_PER_TASK) return [];
      stats.calls += 1;
      const pois = await inner.searchPois(category, keyword, region, signal);
      if (pois.length) stats.gotResults = true;
      return pois;
    },
    selfCheck: () => inner.selfCheck(),
  };
  return { source, stats };
}
