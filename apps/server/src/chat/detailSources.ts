/**
 * 详情对话的外部数据源包装：带预算账本、去重缓存与调用次数上限。
 *
 * 一轮问答、美食推荐与追加调研共享同一份 `DetailSources`，所以计数、缓存、额度都是
 * 单轮级别的（而非单次调用）：同一关键词查两次只发一次请求，也只算一次额度。
 *
 * 关键约定：额度/账本错误必须**冒泡**（assertHealthy），不能吞成「无资料」——
 * 把预算耗尽伪装成「没查到」会让用户以为没结果，而不是额度用完了。
 */
import type { PoiSource } from '../integrations/geoContracts';
import type { SearchSource, WebSearchHit } from '../integrations/websearch/searchSource';

interface SourceDeps {
  poi: PoiSource;
  search: SearchSource;
  /**
   * 预扣外部额度：search 走 reserveEditorGeoBudget（editor_geo_usage）；
   * poi 走高德时配额由 AmapPoiSource 内部的 amapQuotaLedger 原子扣（amap_service_usage.place），
   * 这里注入的 reserve 恒成功、结算为空操作。
   */
  reserve: (source: 'poi' | 'search', count: number) => Promise<null | ((used: number) => Promise<void>)>;
}

/** 一轮问答、美食和追加调研共享上限与缓存；预算错误必须冒泡，不能吞成无资料。 */
export function createDetailSources(deps: SourceDeps, signal: AbortSignal, allowWeb = true) {
  const notes = new Set<string>();
  const calls = { poi: 0, search: 0 };
  const web: WebSearchHit[] = [];
  let ledgerFailure: unknown;
  const assertHealthy = () => { if (ledgerFailure) throw ledgerFailure; };
  const cache = new Map<string, Promise<unknown[]>>();
  // 统一的调用入口：缓存 → 禁网/未配置 → 轮内次数上限 → 预扣额度 → 执行 → 按实际是否发起结算
  async function call<T>(kind: 'poi' | 'search', key: string, configured: boolean, action: () => Promise<T[]>): Promise<T[]> {
    signal.throwIfAborted();
    const cacheKey = `${kind}:${key.trim().toLowerCase()}`;
    const known = cache.get(cacheKey);
    if (known) return known as Promise<T[]>;
    const pending = (async () => {
      const label = kind === 'poi' ? '地点搜索' : '联网搜索';
      if (kind === 'search' && !allowWeb) { notes.add('按要求未使用联网搜索。'); return []; }
      if (!configured) { notes.add(`${label}尚未配置，使用已有资料回答。`); return []; }
      if (calls[kind] >= (kind === 'poi' ? 4 : 2)) { notes.add(`本轮${label}次数已达上限。`); return []; }
      calls[kind]++;
      // search 一次一个请求；高德 POI 一次一个请求（配额在适配器内部扣）。
      const cost = 1;
      const finish = await deps.reserve(kind, cost).catch((error: unknown) => { ledgerFailure = error; throw error; });
      if (!finish) { notes.add(`今日${label}额度不足。`); return []; }
      let attempted = false;
      try {
        signal.throwIfAborted();
        attempted = true;
        let hits: T[];
        try { hits = await action(); }
        catch (error) {
          signal.throwIfAborted();
          const message = error instanceof Error ? error.message : '';
          if (message.includes('预算已用完')) { notes.add(`今日${label}额度不足。`); }
          else notes.add(`${label}暂不可用，相关信息仍需核实。`);
          return [];
        }
        signal.throwIfAborted();
        if (!hits.length) notes.add(`${label}未返回资料，可能暂无结果或服务暂不可用。`);
        return hits;
      } finally { await finish(attempted ? cost : 0).catch((error: unknown) => { ledgerFailure = error; throw error; }); }
    })();
    cache.set(cacheKey, pending);
    return pending;
  }
  const poi: PoiSource = {
    kind: deps.poi.kind,
    searchPois: (category, keyword, city) => call('poi', `${category}|${city}|${keyword}`, deps.poi.kind !== 'null', () => deps.poi.searchPois(category, keyword, city, signal)),
    selfCheck: () => deps.poi.selfCheck(),
  };
  const search: SearchSource = {
    kind: allowWeb ? deps.search.kind : 'null',
    search: async (query) => {
      const hits = await call('search', query, deps.search.kind !== 'null', () => deps.search.search(query, signal));
      for (const hit of hits) if (!web.some((item) => item.url === hit.url)) web.push(hit);
      return hits;
    },
    selfCheck: () => deps.search.selfCheck(),
  };
  return { poi, search, notes, calls, web, assertHealthy };
}
export type DetailSources = ReturnType<typeof createDetailSources>;

/** 按当前用户解析数据源（动态 import：未配置时不为该用户加载网络栈） */

export async function resolveDetailSources(userId: string, signal: AbortSignal, allowWeb = true) {
  const { resolvePoiSourceForUser } = await import('../integrations/geoProvider');
  const { resolveSearchSourceForUser } = await import('../integrations/websearch/searchSource');
  const { reserveEditorGeoBudget } = await import('../services/quotaService');
  const { source: search } = await resolveSearchSourceForUser(userId);
  const poi = await resolvePoiSourceForUser(userId);
  // 高德 POI 的配额在适配器内部原子扣（amap_service_usage.place），editor 账本只管 search。
  const noop = async () => async () => {};
  return createDetailSources({
    poi: poi.source,
    search,
    reserve: (source, count) => source === 'search' ? reserveEditorGeoBudget('search', count) : noop(),
  }, signal, allowWeb);
}
