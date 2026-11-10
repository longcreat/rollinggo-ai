// 主 Agent 与生成子代理共用的只读检索工具（统一工具面的第一步）。
//
// 两边做的是同一件事：把片区当面状检索、搜全网攻略。差异只在
//   · 片区从哪来（对话按名称解析中心；规划用 list_areas 的 areaId）
//   · 结果落到哪（对话写点位缓存与 overview；规划写候选池）
//   · 配额闸门（各自内部处理）
// 所以这里只保留 SDK 无关的核心实现；对话侧包成 pi-durable ToolRegistration、
// 规划侧包成 pi-agent-core AgentTool，避免两份逻辑随规则漂移。
import type { SourcedPoi } from '@rollinggo-trip/integrations/geoContracts';
import { classifySubPoi } from '@rollinggo-trip/services/geofenceImport';

/** 两个 SDK 都只需要这三个字段；对话侧从 WebSearchHit 里裁出。 */
export interface WebHit {
  title: string;
  url: string;
  summary: string;
  datePublished?: string;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface ResolvedArea {
  name: string;
  center: GeoPoint;
  radiusM: number;
}

export type AreaResolution = { ok: true; area: ResolvedArea } | { ok: false; error: string };

export interface AreaAccess {
  readonly signal: AbortSignal;
  /** 按片区名或片区 id 解析中心与半径（解析失败返回可读错误）。 */
  resolve(input: { area?: string; areaId?: string; city?: string }): Promise<AreaResolution>;
  /** 面状检索；配额/闸门由 access 内部处理，超限返回错误。 */
  search(input: { center: GeoPoint; radiusM: number; keywords?: string }): Promise<{ ok: true; pois: SourcedPoi[] } | { ok: false; error: string }>;
  /** 结果接收：对话写点位缓存/overview，规划写候选池。 */
  accept(pois: readonly SourcedPoi[], area: ResolvedArea): void;
}

export interface WebAccess {
  readonly signal: AbortSignal;
  search(query: string, options?: { topic?: 'general' | 'news'; days?: number; maxResults?: number }): Promise<{ ok: true; hits: WebHit[] } | { ok: false; error: string }>;
}

export interface WebFetchAccess {
  readonly signal: AbortSignal;
  fetch(url: string): Promise<{ ok: true; page: { title: string; url: string; content: string } } | { ok: false; error: string }>;
}

export interface ToolCore {
  name: string;
  description: string;
  parameters: object;
  run(args: Record<string, unknown>): Promise<{ text: string; details?: Record<string, string | number | boolean>; isError?: boolean }>;
}

function clampRadius(value: unknown): number {
  const parsed = Number(value ?? 2500) || 2500;
  return Math.min(Math.max(parsed, 300), 8000);
}

/** 片区面状检索：参数同时接受片区名与 areaId，容量与落库由 access 决定。 */
export function searchAreaPlacesCore(access: AreaAccess): ToolCore {
  return {
    name: 'search_area_places',
    description: '把景区/商圈当面状区域，返回区域内可编排的真实景点（如西湖→断桥/白堤/苏堤）。area 用名称，areaId 用 list_areas 返回的片区 id；查具体地点名用 search_places。',
    parameters: {
      type: 'object',
      properties: {
        area: { type: 'string', description: '片区名称，如「西湖」「宽窄巷子」' },
        areaId: { type: 'string', description: 'list_areas 返回的片区 id（规划时优先）' },
        city: { type: 'string', description: '可选，片区所在城市（如杭州、北京、成都），缺省使用当前行程或会话城市' },
        radiusM: { type: 'string', description: '检索半径（米），300–8000' },
        keywords: { type: 'string', description: '补充关键词，如「博物馆」「观景」' },
      },
      additionalProperties: false,
    },
    async run(args) {
      access.signal.throwIfAborted();
      const area = typeof args.area === 'string' ? args.area : undefined;
      const areaId = typeof args.areaId === 'string' ? args.areaId : undefined;
      const city = typeof args.city === 'string' ? args.city : undefined;
      const keywords = typeof args.keywords === 'string' ? args.keywords : undefined;
      if (!area && !areaId) return { text: '错误：需要 area（片区名）或 areaId', isError: true };
      const resolved = await access.resolve({ ...(area ? { area } : {}), ...(areaId ? { areaId } : {}), ...(city ? { city } : {}) });
      if (!resolved.ok) return { text: resolved.error, isError: true };
      const radiusM = args.radiusM === undefined ? resolved.area.radiusM : clampRadius(args.radiusM);
      const found = await access.search({ center: resolved.area.center, radiusM, ...(keywords ? { keywords } : {}) });
      if (!found.ok) return { text: found.error, isError: true };
      const accepted = found.pois.filter((poi) => classifySubPoi(poi, { center: resolved.area.center }) === null && poi.location);
      access.accept(accepted, { ...resolved.area, radiusM });
      return {
        text: JSON.stringify({
          area: resolved.area.name,
          center: resolved.area.center,
          radiusM,
          returned: found.pois.length,
          places: accepted.slice(0, 20).map((poi) => ({
            name: poi.name, type: poi.type, address: poi.address,
            lat: poi.location!.lat, lng: poi.location!.lng,
            ...(poi.opentime ? { openTime: poi.opentime } : {}),
          })),
        }),
        details: { returned: found.pois.length, accepted: accepted.length },
      };
    },
  };
}

export function webSearchCore(access: WebAccess): ToolCore {
  return {
    name: 'web_search',
    description: '搜索全网攻略、资讯与实时信息（新闻要闻、玩法攻略、开放时间、门票政策、口碑）。返回标题、摘要与链接。可指定 topic 为 news（新闻要闻）或 general（通用网页，缺省）。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言搜索词（如「杭州 今日要闻」「西湖 门票预约 开放时间」）' },
        topic: {
          type: 'string',
          enum: ['general', 'news'],
          description: '可选搜索主题：general（通用网页、景点、攻略，缺省），news（实时新闻、今日要闻、最新动态）',
        },
        max_results: {
          type: 'integer',
          description: '可选返回结果数量（1–10，缺省 8）',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(args) {
      access.signal.throwIfAborted();
      const query = typeof args.query === 'string' ? args.query.slice(0, 200) : '';
      if (!query) return { text: '错误：query 不能为空', isError: true };
      const topic = args.topic === 'news' || args.topic === 'general' ? args.topic : undefined;
      const maxResults = typeof args.max_results === 'number' ? Math.min(Math.max(args.max_results, 1), 10) : 8;
      const found = await access.search(query, { ...(topic ? { topic } : {}), maxResults });
      if (!found.ok) return { text: found.error, isError: true };
      return { text: JSON.stringify({ hits: found.hits.slice(0, maxResults) }), details: { count: found.hits.length } };
    },
  };
}

export function webFetchCore(access: WebFetchAccess): ToolCore {
  return {
    name: 'fetch_web_page',
    description: '提取指定网页的完整正文 Markdown 内容。当 web_search 返回的摘要不够详尽，或者需要深入核实某一景区的官方公告、预约政策细节、新闻通报全文时调用。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '需要提取正文的完整网页 URL（通常来自 web_search 的结果）' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async run(args) {
      access.signal.throwIfAborted();
      const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';
      if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
        return { text: '错误：url 必须是以 http:// 或 https:// 开头的合法网页链接', isError: true };
      }
      const res = await access.fetch(rawUrl);
      if (!res.ok) return { text: res.error, isError: true };
      const { title, url, content } = res.page;
      const truncated = content.length > 5000 ? `${content.slice(0, 5000)}\n\n...(内容过长已截断)` : content;
      return {
        text: JSON.stringify({ title, url, content: truncated }),
        details: { url, contentLength: content.length },
      };
    },
  };
}