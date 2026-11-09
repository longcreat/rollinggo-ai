// Web 搜索适配层：通过 Tavily 官方 API 提供高质量实时网络搜索、内容提炼与事实溯源。
// 遵循成熟 Harness 的设计原则：直接透传自然语言 Query，由专业 AI 搜索引擎完成意图识别与排序，
// 零人工关键词正则篡改，零脆弱硬编码。
import { env } from '../../env';
import { createSerialQueue } from '../../lib/serialQueue';
import { TtlCache } from '../../lib/ttlCache';
import { resolveSearchCredential } from '../../services/settingsService';
import { assertSafeBaseUrl } from '../ssrfGuard';
import type { SourceStatus } from '../sourceStatus';

const SEARCH_MIN_INTERVAL_MS = 500;
const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RESULTS = 8;

export interface WebSearchHit {
  title: string;
  url: string;
  summary: string;
  siteName?: string;
  datePublished?: string;
  score?: number;
}

export interface WebPageContent {
  title: string;
  url: string;
  content: string;
}

export interface SearchOptions {
  topic?: 'general' | 'news';
  days?: number;
  maxResults?: number;
}

export interface SearchSource {
  readonly kind: 'websearch' | 'null';
  search(query: string, signal?: AbortSignal, options?: SearchOptions): Promise<WebSearchHit[]>;
  extract?(url: string, signal?: AbortSignal): Promise<WebPageContent | null>;
  selfCheck(): Promise<SourceStatus>;
}

// ---------- Null 降级 ----------

export class NullSearchSource implements SearchSource {
  readonly kind = 'null' as const;
  constructor(private reason = '站点未配置 Web 搜索 Key') {}

  async search(): Promise<WebSearchHit[]> {
    return [];
  }
  async extract(): Promise<WebPageContent | null> {
    return null;
  }
  async selfCheck(): Promise<SourceStatus> {
    return { configured: false, checked: true, ok: null, message: `${this.reason}（生成时自动降级为模型知识调研）` };
  }
}

// ---------- Tavily API 实现 ----------

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function resolveTavilyEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/search') ? trimmed : `${trimmed}/search`;
}

function resolveTavilyExtractEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/search')) {
    return `${trimmed.slice(0, -7)}/extract`;
  }
  return trimmed.endsWith('/extract') ? trimmed : `${trimmed}/extract`;
}

export class TavilySearchSource implements SearchSource {
  readonly kind = 'websearch' as const;
  private queue = createSerialQueue(SEARCH_MIN_INTERVAL_MS);
  private cache = new TtlCache<WebSearchHit[]>(SEARCH_CACHE_TTL_MS, 300);

  private extractCache = new TtlCache<WebPageContent | null>(60 * 60 * 1000, 100);

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private validateBaseUrlBeforeUse = false,
  ) {}

  /** 提取指定网页正文 Markdown 内容 */
  async extract(url: string, signal?: AbortSignal): Promise<WebPageContent | null> {
    signal?.throwIfAborted();
    if (!/^https?:\/\//i.test(url)) return null;
    const cached = this.extractCache.get(url);
    if (cached !== undefined) return cached;

    return this.queue(async () => {
      signal?.throwIfAborted();
      if (this.validateBaseUrlBeforeUse) await assertSafeBaseUrl(this.baseUrl);
      const endpoint = resolveTavilyExtractEndpoint(this.baseUrl);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          api_key: this.apiKey,
          urls: [url],
          format: 'markdown',
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Record<string, unknown>;
      const results = Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : [];
      if (!results.length) {
        this.extractCache.set(url, null);
        return null;
      }

      const item = results[0]!;
      const content = str(item.raw_content) || str(item.content);
      const page: WebPageContent = {
        title: str(item.title) || url,
        url: str(item.url) || url,
        content: content.slice(0, 8000),
      };
      this.extractCache.set(url, page);
      return page;
    });
  }

  /** 失败抛给调用方分支处理 */
  private async request(query: string, count: number, signal?: AbortSignal, options?: SearchOptions): Promise<WebSearchHit[]> {
    return this.queue(async () => {
      signal?.throwIfAborted();
      if (this.validateBaseUrlBeforeUse) await assertSafeBaseUrl(this.baseUrl);

      const endpoint = resolveTavilyEndpoint(this.baseUrl);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          api_key: this.apiKey,
          query: query.slice(0, 400),
          search_depth: 'basic',
          include_answer: true,
          max_results: count,
          ...(options?.topic ? { topic: options.topic } : {}),
          ...(options?.days ? { days: options.days } : {}),
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Record<string, unknown>;

      const rawResults = Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : [];
      const hits: WebSearchHit[] = [];

      // 若 Tavily 提供了直接提炼的 answer 综述，优先作为权威精炼事实
      const answer = str(body.answer).trim();
      if (answer) {
        hits.push({
          title: 'Tavily 智能事实综述',
          url: endpoint,
          summary: answer,
          siteName: 'Tavily Answer',
          datePublished: '',
        });
      }

      for (const raw of rawResults) {
        const title = str(raw.title).trim();
        const url = str(raw.url);
        if (!title || !/^https?:\/\//.test(url)) continue;
        hits.push({
          title: title.slice(0, 100),
          url: url.slice(0, 300),
          summary: str(raw.content) || str(raw.snippet),
          datePublished: str(raw.published_date).slice(0, 25),
          ...(typeof raw.score === 'number' ? { score: raw.score } : {}),
        });
      }

      return hits.slice(0, count + (answer ? 1 : 0));
    });
  }

  async search(query: string, signal?: AbortSignal, options?: SearchOptions): Promise<WebSearchHit[]> {
    signal?.throwIfAborted();
    const count = options?.maxResults ? Math.min(Math.max(options.maxResults, 1), 10) : MAX_RESULTS;
    const topic = options?.topic ?? 'general';
    const key = `${query.trim().toLowerCase()}:${topic}:${count}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    try {
      const hits = await this.request(query, count, signal, options);
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
      await this.request('故宫 开放时间', 1);
      return { configured: true, checked: true, ok: true, message: 'Tavily 搜索数据源连接正常' };
    } catch (err) {
      return {
        configured: true,
        checked: true,
        ok: false,
        message: `Tavily 搜索连接失败：${err instanceof Error ? err.message : '未知错误'}（生成时自动降级）`,
      };
    }
  }
}

/** 保持别名导出以兼容已有类型引用 */
export { TavilySearchSource as WebSearchSource };

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
    async search(query, signal, options) {
      signal?.throwIfAborted();
      if (inner.kind === 'null') return [];                  // Null 源不计数，不烧日额度
      if (stats.calls >= SEARCH_MAX_PER_TASK) return [];
      stats.calls += 1;
      const hits = await inner.search(query, signal, options);
      if (hits.length) stats.gotResults = true;
      return hits;
    },
    async extract(url, signal) {
      signal?.throwIfAborted();
      if (inner.kind === 'null' || !inner.extract) return null;
      return inner.extract(url, signal);
    },
    selfCheck: () => inner.selfCheck(),
  };
  return { source, stats };
}

// ---------- 按用户动态构造 ----------

const nullSource = new NullSearchSource();
const webSource = env.searchApiKey ? new TavilySearchSource(env.searchApiBaseUrl, env.searchApiKey) : null;

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
  return baseUrl && apiKey ? new TavilySearchSource(baseUrl, apiKey, validateBaseUrlBeforeUse) : nullSource;
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
