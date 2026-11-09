// Web 搜索适配层（架构 §6）：调研候选的攻略语义层（玩法/避雷/预约政策）
// 默认 LangSearch；博查同族 schema，改 SEARCH_API_BASE_URL + Key 即可切换，零代码改动。
// 原则沿用 ContentSource 骨架：串行限速 + TTL 缓存 + 任务级上限 + Null 降级 + selfCheck，
// 任何故障不抛错到上层 —— search 回空数组、selfCheck 变红。
import { env } from '../../env';
import { createSerialQueue } from '../../lib/serialQueue';
import { TtlCache } from '../../lib/ttlCache';
import { resolveSearchCredential } from '../../services/settingsService';
import { assertSafeBaseUrl } from '../ssrfGuard';
import type { SourceStatus } from '../sourceStatus';

const SEARCH_MIN_INTERVAL_MS = 1000;              // 免费档限流未明示，串行 1s 保守姿态
const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RESULTS = 6;

export interface WebSearchHit {
  title: string;
  url: string;
  summary: string;        // LangSearch summary 优先，缺失回退 snippet
  siteName: string;
  datePublished: string;  // 'YYYY-MM-DD' 或 ''
}

export interface SearchOptions {
  freshness?: 'oneDay' | 'oneWeek' | 'oneMonth' | 'oneYear' | 'noLimit';
}

export interface SearchSource {
  readonly kind: 'websearch' | 'null';
  search(query: string, signal?: AbortSignal, options?: SearchOptions): Promise<WebSearchHit[]>;
  selfCheck(): Promise<SourceStatus>;
}

// ---------- Null 降级 ----------

export class NullSearchSource implements SearchSource {
  readonly kind = 'null' as const;
  constructor(private reason = '站点未配置 Web 搜索 Key') {}

  async search(): Promise<WebSearchHit[]> {
    return [];
  }
  async selfCheck(): Promise<SourceStatus> {
    return { configured: false, checked: true, ok: null, message: `${this.reason}（生成时自动降级为模型知识调研）` };
  }
}

// ---------- 宽容解析（LangSearch / 博查同族：data.webPages.value） ----------

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function pickPages(body: unknown): Record<string, unknown>[] {
  const root = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const data = (root.data ?? root) as Record<string, unknown>;
  const webPages = (data.webPages ?? {}) as Record<string, unknown>;
  return Array.isArray(webPages.value) ? (webPages.value as Record<string, unknown>[]) : [];
}

function mapHit(raw: Record<string, unknown>): WebSearchHit | null {
  const title = str(raw.name).trim();
  const url = str(raw.url);
  if (!title || !/^https?:\/\//.test(url)) return null;
  return {
    title: title.slice(0, 80),
    url: url.slice(0, 300),
    // 摘要不截断：上游 summary 已是浓缩结果，再按字数砍会让模型「记不住」关键条件。
    // 上下文膨胀交给 pi-durable 的 compaction（阈值/溢出都会摘要旧轮次），而不是丢数据。
    summary: str(raw.summary) || str(raw.snippet),
    siteName: str(raw.siteName).slice(0, 30),
    datePublished: str(raw.datePublished).slice(0, 10),
  };
}

// ---------- LangSearch（博查同族）实现 ----------

export class WebSearchSource implements SearchSource {
  readonly kind = 'websearch' as const;
  private queue = createSerialQueue(SEARCH_MIN_INTERVAL_MS);
  private cache = new TtlCache<WebSearchHit[]>(SEARCH_CACHE_TTL_MS, 300);

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private validateBaseUrlBeforeUse = false,
  ) {}

  /** 失败抛给调用方分支处理 */
  private async request(query: string, count: number, signal?: AbortSignal, freshness: string = 'noLimit'): Promise<WebSearchHit[]> {
    return this.queue(async () => {
      signal?.throwIfAborted();
      if (this.validateBaseUrlBeforeUse) await assertSafeBaseUrl(this.baseUrl);

      // 搜索词智能容错：清洗误注入的未来年份（如 2026年 / 2026-），避免搜索引擎匹配不到新闻
      let sanitizedQuery = query.slice(0, 100);
      if (/202[6-9]/.test(sanitizedQuery) && /(新闻|今日|今天|最新|突发|动态|管制|公告)/.test(sanitizedQuery)) {
        sanitizedQuery = sanitizedQuery.replace(/202[6-9][\-\/年]?\d{0,2}[\-\/月]?\d{0,2}日?/g, '').replace(/\s+/g, ' ').trim();
        if (!sanitizedQuery) sanitizedQuery = query.slice(0, 100);
      }

      // 时效性智能推断：如果未显式指定 freshness，但搜索词含有“今天/今日/单日/突发/最新动态”，自动设为相应时效范围
      let effectiveFreshness = freshness;
      if (effectiveFreshness === 'noLimit') {
        if (/(今天|今日|突发|最新新闻|今日新闻|\d{1,2}月\d{1,2}日)/.test(query)) {
          effectiveFreshness = 'oneDay';
        } else if (/(新闻|最新动态|近期变化|最新消息)/.test(query)) {
          effectiveFreshness = 'oneWeek';
        }
      }

      const res = await fetch(`${this.baseUrl}/v1/web-search`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: sanitizedQuery, summary: true, count, freshness: effectiveFreshness }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const hits = pickPages(await res.json())
        .map(mapHit)
        .filter((h): h is WebSearchHit => h !== null);
      return hits.slice(0, count);
    });
  }

  async search(query: string, signal?: AbortSignal, options?: SearchOptions): Promise<WebSearchHit[]> {
    signal?.throwIfAborted();
    const freshness = options?.freshness ?? 'noLimit';
    const key = `${query.trim().toLowerCase()}:${freshness}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    try {
      const hits = await this.request(query, MAX_RESULTS, signal, freshness);
      signal?.throwIfAborted();
      this.cache.set(key, hits);
      return hits;
    } catch {
      signal?.throwIfAborted();
      return [];                               // 不抛错：调研 Agent 自动降级为模型知识
    }
  }

  async selfCheck(): Promise<SourceStatus> {
    try {
      await this.request('故宫 门票 预约', 1);
      return { configured: true, checked: true, ok: true, message: 'Web 搜索数据源连接正常' };
    } catch (err) {
      return {
        configured: true,
        checked: true,
        ok: false,
        message: `Web 搜索连接失败：${err instanceof Error ? err.message : '未知错误'}（生成时自动降级）`,
      };
    }
  }
}

// ---------- 任务级上限包装（单次生成 ≤10 次搜索） ----------

export const SEARCH_MAX_PER_TASK = 10;

export interface TaskSearchSource {
  source: SearchSource;
  stats: { calls: number; gotResults: boolean };
}

export function createTaskSearchSource(inner: SearchSource): TaskSearchSource {
  const stats = { calls: 0, gotResults: false };
  const source: SearchSource = {
    kind: inner.kind,
    async search(query, signal) {
      signal?.throwIfAborted();
      if (inner.kind === 'null') return [];                  // Null 源不计数，不烧日额度
      if (stats.calls >= SEARCH_MAX_PER_TASK) return [];
      stats.calls += 1;
      const hits = await inner.search(query, signal);
      if (hits.length) stats.gotResults = true;
      return hits;
    },
    selfCheck: () => inner.selfCheck(),
  };
  return { source, stats };
}

// ---------- 按用户动态构造 ----------

const nullSource = new NullSearchSource();
const webSource = env.searchApiKey ? new WebSearchSource(env.searchApiBaseUrl, env.searchApiKey) : null;

export interface ResolvedSearchSource {
  source: SearchSource;
  credentialRevision: string;
  credentialOrigin: 'personal' | 'site' | 'none';
}

/** 构造请求级/任务级搜索源；个人 Base URL 会在每次真实请求前再次做 SSRF 校验。 */
export function createSearchSource(
  baseUrl: string | null | undefined,
  apiKey: string | null | undefined,
  validateBaseUrlBeforeUse = false,
): SearchSource {
  return baseUrl && apiKey ? new WebSearchSource(baseUrl, apiKey, validateBaseUrlBeforeUse) : nullSource;
}

/** 个人配置优先；个人 URL 在构造前复查，不安全时降级而不是中断生成。 */
export async function resolveSearchSourceForUser(userId: string): Promise<ResolvedSearchSource> {
  const credential = await resolveSearchCredential(userId);
  if (!credential) {
    return { source: nullSource, credentialRevision: 'none', credentialOrigin: 'none' };
  }
  if (credential.origin === 'site') {
    return { source: getSearchSource(), credentialRevision: credential.revision, credentialOrigin: 'site' };
  }
  try {
    await assertSafeBaseUrl(credential.baseUrl);
    return {
      source: createSearchSource(credential.baseUrl, credential.apiKey, true),
      credentialRevision: credential.revision,
      credentialOrigin: 'personal',
    };
  } catch {
    return {
      source: new NullSearchSource('个人 Web 搜索 Base URL 安全校验未通过'),
      credentialRevision: credential.revision,
      credentialOrigin: 'personal',
    };
  }
}

/** 站点级搜索源：未配置 SEARCH_API_KEY 时为 Null 降级 */
export function getSearchSource(): SearchSource {
  return webSource ?? nullSource;
}

/** 全站日额度用尽等场景下按需取用 Null 源 */
export function getNullSearchSource(): SearchSource {
  return nullSource;
}
