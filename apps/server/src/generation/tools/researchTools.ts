// 调研 Agent 工具组：高德地点搜索 + Web 攻略搜索 + 候选池写入 + 摘要提交
// 工具返回一律为紧凑文本 —— 结构化候选经闭包（outcome.pool）持有，不靠模型转述（R8）
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  MAX_OVERVIEW_POIS,
  MAX_SOURCE_NOTES,
  POI_CATEGORIES,
  uid,
  type PoiCategory,
  type ResearchPoi,
} from '@tripweaver/shared';
import { defineTool } from './defineTool';
import type { PoiSource } from '../../integrations/geoContracts';
import type { SearchSource } from '../../integrations/websearch/searchSource';
import { matchReservationSeed } from '../../data/reservationSeeds';
import { findXhsEvidence, findXhsPlace } from '../../services/xhsPlaceService';
import { isUsableResearchLocation, rememberResearchLocation, type ResearchLocation } from '../placeLookup';
import { retrieveContext, type RetrievedPlace } from '../retrieveContext';
import { renderRetrievedPlaces } from '../researchContext';
import { placeCategory } from '../retrievalRanking';
import { cleanResearchIntro, normalizeReservation, purifiedIntro, purifiedIntroSources } from '../researchQuality';
import { renderOpenHours, normalizePlaceKey } from '../scheduling/placeFacts';
import { createPlaceIdentityIndex, canonicalPlaceId } from '../../lib/placeIdentity';
import { samePlaceReference, uniquePlaceReferences } from '@tripweaver/shared';
import { loadPlaceIdentityIndex } from '../../services/placeIdentityService';
import type { AmapPoiPhotoLookup } from '../../integrations/amap/poiPhotos';

function text(t: string) {
  return [{ type: 'text' as const, text: t }];
}

const CATEGORY_LABEL: Record<PoiCategory, string> = { attraction: '景点', food: '美食', hotel: '住宿' };
/** 知识库空命中提示：先把模型推回知识库换关键词，仅在连续无命中时才松口到 search_web（降级纪律的唯一执行点） */
const FALLBACK_HINT =
  '已验证库无命中：先换一个关键词再查（换片区、换主题、换同义说法）；连续多次仍无命中时，才用 search_web 兜底。';
export interface ResearchOutcome {
  summary: string;
  pool: ResearchPoi[];
  /** 坐标旁路（距离预计算与定位复用）：地点搜索及已验证候选的唯一 name → GCJ-02 坐标/adcode。
   *  仅任务内存短暂持有，不入候选池 schema、不随行程持久化（高德协议 3.5：仅存活动坐标点值） */
  locations: Map<string, ResearchLocation>;
}

export interface ResearchToolDeps {
  verifiedPlaces?: readonly RetrievedPlace[];
  retrieve?: typeof retrieveContext;
  acceptPlace?: (name: string, aliases?: readonly string[], canonicalPlaceId?: string) => boolean;
  /** 对话追加必须有库内实体或本轮地点搜索坐标，不能凭模型知识造新地点。 */
  groundedOnly?: boolean;
  signal?: AbortSignal;
  foodSearch?: boolean;
  poiSource: PoiSource;
  searchSource: SearchSource;
  destination: string;
  /** search_web 上限提示（注入工具描述与降级纪律文案；实际计数由 SEARCH_DAILY_BUDGET 日预算兜底） */
  searchWebMax: number;
  outcome: ResearchOutcome;
  /** 每写入一条候选即回调（orchestrator 借此发 SSE candidate 事件） */
  onCandidate?: (poi: ResearchPoi) => void;
  /** 高德 POI 图片：全站唯一图片来源（search_pois 旁路 → 库内回写 → 实时查询）。 */
  amapPhotos?: AmapPoiPhotoLookup;
  /** 库内已回写的高德图片（09-27）：命中则跳过实时查询，省下稀缺的搜索配额。 */
  storedAmapPhoto?: (name: string) => Promise<string | null>;
  /** 高德新命中后的回写（fire-and-forget）；未注入时不写。 */
  saveAmapPhoto?: (name: string, url: string) => void;
}

function isHttpUrl(u: string): boolean {
  return /^https?:\/\//.test(u);
}

/**
 * 人均消费展示：高德返回「133.00」这种两位小数，去掉无意义的尾零。
 * 解析不出来就原样保留，不吞掉上游信息。
 */
function formatCost(raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return raw;
  return `¥${Number.isInteger(value) ? value : value.toFixed(2)}`;
}

/**
 * 封面 URL 归一：只接受可热链的 https 外链。
 * 图片来源已收敛为高德 POI（全部是外链热链），不再接受站内相对路径；
 * 高德返回值 http/https 混用，统一改写成 https，否则 https 页面会被 mixed content 拦掉。
 */
function httpsCoverUrl(raw: string): string | null {
  const url = raw.trim();
  if (url.startsWith('https://')) return url;
  if (url.startsWith('http://')) return `https://${url.slice(7)}`;
  return null;
}

/**
 * 封面解析（2026-11-05 收敛为高德 POI 单一来源）。
 * 实测外部图库（Pexels/Pixabay/Unsplash/Commons）在国内景点命中率低、与具体地点对应关系弱，
 * 而高德每个 POI 自带多张官方图，因此三条路径按成本从低到高：
 * 1. `search_pois` 同一次调用带回的官方图片（零额外配额，≤3 张）
 * 2. 库内已回写的高德图（`canonical_places.payload.amapPhoto`，同一地点只花一次配额）
 * 3. 实时高德 `place/text` 查询（受任务上限与 place 日预算约束）
 * 名称按归一键对齐：候选「故宫博物院」对得上搜索结果「故宫」。
 */
async function resolveCover(
  name: string,
  city: string,
  deps: {
    amapPhotos: AmapPoiPhotoLookup;
    storedAmapPhoto: (name: string) => Promise<string | null>;
    saveAmapPhoto: (name: string, url: string) => void;
    /** search_pois 旁路：高德搜索已带回的官方图片，零额外配额 */
    searchPhotos?: (name: string) => readonly string[] | undefined;
  },
): Promise<Pick<ResearchPoi, 'coverUrl' | 'photos'> | null> {
  const fromUrls = (urls: readonly string[]) => {
    const photos = [...new Set(urls.map(httpsCoverUrl).filter((url): url is string => Boolean(url)))]
      .slice(0, 3).map((url) => ({ url: url.slice(0, 300) }));
    return photos[0] ? { coverUrl: photos[0].url, photos } : null;
  };

  const searched = fromUrls(deps.searchPhotos?.(name) ?? []);
  if (searched) return searched;

  const stored = await deps.storedAmapPhoto(name).catch(() => null);
  if (stored) {
    const cached = fromUrls([stored]);
    if (cached) return cached;
  }

  // 图片失败不影响候选入池：生成不失败原则，缺图交给前端类目占位。
  const live = fromUrls(await deps.amapPhotos.photosFor({ name, city }).catch(() => []));
  if (live) deps.saveAmapPhoto(name, live.coverUrl);
  return live;
}

export function buildResearchTools(deps: ResearchToolDeps): AgentTool[] {
  const { poiSource, searchSource, destination, outcome, onCandidate } = deps;
  // 未注入时用空实现：单测与离线回放不发请求。真实生成由 orchestrator 显式注入。
  const amapPhotos = deps.amapPhotos ?? { photosFor: async () => [], calls: 0 };
  const storedAmapPhoto = deps.storedAmapPhoto ?? (async () => null);
  const saveAmapPhoto = deps.saveAmapPhoto ?? (() => {});
  const ambiguousNames = new Set<string>();
  // 营业时间旁路捕获（09-22-opentime）：search_pois 如实带回高德 opentime 文本，add_candidate 同名自动回填，
  // 不让模型转抄（转抄会失真）。仅 attraction 入排程检测，food/hotel 不消费。
  const openTimeByName = new Map<string, string>();
  // 图片旁路（2026-11-05）：高德 search_pois 自带官方图片，按规范名索引供封面零成本复用；
  // 此前封面只能走限流的高德独立查找（每次生成 ≤3 次），绝大多数活动落到占位图。
  const photoUrlsByName = new Map<string, string[]>();
  const knownPlaces = new Map((deps.verifiedPlaces ?? []).map((place) => [place.id, place]));
  let cityIdentityIndex: ReturnType<typeof loadPlaceIdentityIndex> | undefined;
  // 只共享本任务结果，取消和城市范围不跨任务串扰。
  const searches = new Map<string, Promise<RetrievedPlace[]>>();

  const verifiedTool = defineTool({
    name: 'search_verified_places',
    label: '查已验证地点库',
    description:
      '补查已验证地点库（含证据强度、来源、地点id）。系统预取已够用时不必调用；缺项时可空格分组查询具体地名、别名和主题。默认景点，复杂自然语言偏好可传 semantic=true。结果足量时跳过向量。',
    parameters: Type.Object({
      keyword: Type.String({ description: '检索关键词，如「故宫 颐和园 历史人文」「胡同 什刹海」；不必带目的地名' }),
      category: Type.Optional(Type.Union([Type.Literal('attraction'), Type.Literal('food')], { description: '默认景点；美食偏好需要餐饮时填 food' })),
      semantic: Type.Optional(Type.Boolean({ description: '仅复杂自然语言偏好需语义补充时为 true；具体地点名查询不需要' })),
    }),
    execute: async (_id, params) => {
      const keyword = params.keyword.trim();
      if (!keyword) return { content: text('错误：keyword 不能为空。'), details: { ok: false } };
      // 分词语义（09-25）：模型实测给「故宫 历史文化」「颐和园 景山 国子监」这类空格分隔短语，
      // 整串当地点名匹配必然空转（实测对照组命中 0 条）。拆词后精确名/主题标签层才真正生效，
      // 向量层仍用整串做语义召回（retrieveContext 内部 names.join(' ')）。
      const terms = [...new Set(keyword.split(/[\s,，、]+/).filter(Boolean))].slice(0, 8);
      let places;
      try {
        const category = params.category ?? 'attraction';
        if (category === 'food' && deps.foodSearch === false) return { content: text('本次未选择美食偏好，请继续筛选景点。'), details: { count: 0 } };
        const key = JSON.stringify([category, Boolean(params.semantic), terms]);
        let pending = searches.get(key);
        if (!pending) {
          pending = (deps.retrieve ?? retrieveContext)(terms, { city: destination, category, signal: deps.signal, vector: params.semantic ? 'force' : 'auto' });
          searches.set(key, pending);
        }
        places = await pending;
      } catch {
        return { content: text(FALLBACK_HINT), details: { count: 0 } };
      }
      if (!places.length) {
        return { content: text(FALLBACK_HINT), details: { count: 0 } };
      }
      for (const place of places) knownPlaces.set(place.id, place);
      return { content: text(renderRetrievedPlaces(places)), details: { count: places.length, keyword } };
    },
  });

  const poisTool = defineTool({
    name: 'search_pois',
    label: '搜索地点',
    description:
      '按类目搜索目的地的真实地点（高德数据），返回名称、类型、地址与官方图片。用途只有一个：补知识库未覆盖的地点——候选坐标与封面图片由系统从搜索结果自动取用，不必为了坐标或图片反复调它；评分/人均需企业认证，个人 Key 不返回，不要追问。',
    parameters: Type.Object({
      category: Type.String({ description: '类目：attraction（景点）/ food（美食）/ hotel（住宿）' }),
      keyword: Type.String({ description: '搜索关键词，如「必去景点」「本地菜」「市中心酒店」，不必带目的地名' }),
    }),
    execute: async (_id, params) => {
      const category = params.category.trim() as PoiCategory;
      if (!(POI_CATEGORIES as readonly string[]).includes(category)) {
        return { content: text('错误：category 必须是 attraction / food / hotel 之一。'), details: { ok: false } };
      }
      const pois = await poiSource.searchPois(category, params.keyword, destination, deps.signal);
      if (!pois.length) {
        return {
          content: text('没有找到相关地点（搜索不可用、已达调用上限或无结果）。可换个关键词，或基于你自己的知识直接 add_candidate。'),
          details: { count: 0 },
        };
      }
      // 坐标旁路捕获（层2 距离预计算用）：搜索结果已如实带回 GCJ-02 坐标，零额外调用；
      // 后续 add_candidate 的候选按同名关联（模型改写名称导致失配时仅漏标，由层3 兜底）
      for (const p of pois) {
        if (p.location) rememberResearchLocation(outcome.locations, ambiguousNames, p.name, { ...p.location, adcode: p.adcode });
        if (p.opentime) openTimeByName.set(p.name, p.opentime);
        if (p.photoUrls.length) photoUrlsByName.set(normalizePlaceKey(p.name), p.photoUrls);
      }
      const lines = pois.map((p, i) => {
        const bits = [
          `${i + 1}. ${p.name}`,
          p.type,
          p.address,
          p.rating ? `评分 ${p.rating}` : '',
          p.cost ? `人均 ${formatCost(p.cost)}` : '',
          p.opentime ? `营业 ${p.opentime}` : '',
          p.tel ? `电话 ${p.tel}` : '',
          p.photoUrls[0] ? `图片=${p.photoUrls[0]}` : '',
        ];
        return bits.filter(Boolean).join('｜');
      });
      return { content: text(lines.join('\n')), details: { count: pois.length, category, keyword: params.keyword } };
    },
  });

  const webTool = defineTool({
    name: 'search_web',
    label: '搜索攻略',
    description:
      `全网搜索旅行攻略、玩法、避雷与预约政策，返回标题/摘要/来源链接。降级兜底工具：仅当 search_verified_places 连续多次无命中或候选明显凑不齐时才使用，全阶段最多 ${deps.searchWebMax} 次。`,
    parameters: Type.Object({
      query: Type.String({ description: '搜索词，如「故宫 门票 预约」「XX市 三日游 避雷」' }),
    }),
    execute: async (_id, params) => {
      const hits = await searchSource.search(params.query, deps.signal);
      if (!hits.length) {
        return {
          content: text('没有搜到相关内容（搜索数据源不可用、已达调用上限或无结果）。可换个说法，或基于你自己的知识继续。'),
          details: { count: 0 },
        };
      }
      const lines = hits.map(
        (h, i) =>
          `${i + 1}. ${h.title}${h.siteName ? `｜${h.siteName}` : ''}${h.datePublished ? `｜${h.datePublished}` : ''}\n   ${h.summary}\n   url=${h.url}`,
      );
      return { content: text(lines.join('\n')), details: { count: hits.length, query: params.query } };
    },
  });

  // 同名去重是「查池 → await 查库 → push」：pi-agent-core 默认并行执行同一轮工具调用，
  // 两个同名 add_candidate 会在 await 窗口前都看到空池而重复入池（09-21 复现，
  // 09-18 异步化引入）。标记 sequential 让它串行执行，恢复去重语义。
  const addTool = defineTool({
    name: 'add_candidate',
    label: '写入候选池',
    description: '补充未在已验证库中的外部/模型知识地点。同名去重；已有 placeId 的地点优先在 submit_research.candidates 中一次提交。',
    executionMode: 'sequential',
    parameters: Type.Object({
      placeId: Type.Optional(Type.String({ description: '预取候选或 search_verified_places 返回的 id；填写后系统复用该地点事实与证据' })),
      name: Type.String({ description: '地点名称（与 search_pois 返回一致）' }),
      category: Type.String({ description: '类目：attraction / food / hotel' }),
      intro: Type.String({ maxLength: 200, description: '完整景点介绍，通常120～180字：地点定位、历史特色、具体看点及有来源的实用信息；系统优先复用上游提纯简介' }),
      coverUrl: Type.Optional(Type.String({ description: '已废弃：封面由系统补，模型给的值会被忽略' })),
      reservation: Type.Optional(
        Type.String({ description: '是否需要预约：required / none / unknown（默认 unknown；仅在有官方或权威来源时才填 required/none）' }),
      ),
      reservationNote: Type.Optional(Type.String({ description: '预约方式说明（≤120 字，如「官方小程序提前 7 天实名预约」）' })),
      sourceLinks: Type.Optional(
        Type.Array(Type.Object({ title: Type.String(), url: Type.String() }), {
          description: '来源链接 ≤3 条，只能用工具返回中出现过的 url',
        }),
      ),
    }),
    execute: async (_id, params) => {
      deps.signal?.throwIfAborted();
      let name = params.name.trim().slice(0, 100);
      if (!name) return { content: text('错误：地点名称不能为空。'), details: { ok: false } };
      const category = params.category.trim() as PoiCategory;
      if (!(POI_CATEGORIES as readonly string[]).includes(category)) {
        return { content: text('错误：category 必须是 attraction / food / hotel 之一。'), details: { ok: false } };
      }
      const index = createPlaceIdentityIndex<RetrievedPlace>([...knownPlaces.values()].map(p => ({ ...p, payload: { ...p.payload, aliases: p.aliases } })));
      let resolution = index.resolve(destination, name, params.placeId);
      if (!params.placeId) {
        // 预取 top-k 不足以证明别名无歧义；名称入池前读取完整同城目录。
        try {
          cityIdentityIndex ??= loadPlaceIdentityIndex(destination);
          const fullIndex = await cityIdentityIndex;
          const cityResolution = fullIndex.resolve(destination, name);
          if (cityResolution.status === 'unresolved' && cityResolution.reason === 'withdrawn') {
            return { content: text('该地点的具体归属待核实，请补充具体分店或选择其他已确认地点。'), details: { ok: false } };
          }
          if (cityResolution.status === 'unresolved' && !outcome.locations.has(name)) {
            const suggestions = fullIndex.candidatesForReview(destination, name);
            if (suggestions.length) return { content: text(`该名称尚未确认身份，可能涉及已有地点或子地点。请先检索并使用明确 placeId，或通过地点搜索核实独立地点：${suggestions.slice(0, 5).map(p => `${p.name}(${p.id})`).join('、')}`), details: { ok: false } };
          }
          if (cityResolution.status !== 'unresolved') {
            resolution = cityResolution.status === 'resolved'
              ? { ...cityResolution, place: knownPlaces.get(cityResolution.place.id) ?? cityResolution.place }
              : cityResolution;
          }
        } catch {
          cityIdentityIndex = undefined;
          return { content: text('地点身份查询暂不可用，请使用已检索的 placeId 或稍后重试。'), details: { ok: false } };
        }
      }
      if (resolution.status === 'ambiguous') {
        return { content: text('存在多个同名地点，请检索并指定对应的 placeId。'), details: { ok: false } };
      }
      let known = resolution.status === 'resolved' ? resolution.place : undefined;
      if (params.placeId && !known) {
        return { content: text('错误：placeId 与已检索的地点名称不一致，请使用候选原名和对应 id。'), details: { ok: false } };
      }
      // 当前检索批次之外的已知别名也必须绑定实体，不能作为自由名称再次入池。
      if (!known) {
        const retrieved = await (deps.retrieve ?? retrieveContext)([name], { city: destination, vector: 'off', limit: 48, signal: deps.signal });
        const resolved = createPlaceIdentityIndex(retrieved).resolve(destination, name);
        if (resolved.status === 'ambiguous') return { content: text('该名称对应多个地点，请先确认具体地点。'), details: { ok: false } };
        if (resolved.status === 'resolved') {
          known = { ...resolved.place, payload: { ...resolved.place.payload, aliases: resolved.place.aliases } };
          knownPlaces.set(known.id, known);
        }
      }
      if (known && (!known.verified || known.city !== destination || placeCategory(known.category) !== category)) {
        return { content: text('错误：候选城市或类目不一致。'), details: { ok: false } };
      }
      if (known) name = known.name;
      if (deps.acceptPlace && !deps.acceptPlace(name, known?.aliases, known ? canonicalPlaceId(known) : undefined)) {
        return { content: text('该地点已在原行程中，请选择不同地点。'), details: { ok: false } };
      }
      if (deps.groundedOnly && !known && !outcome.locations.has(name)) {
        return { content: text('新增日期只使用已检索的知识库地点或有真实坐标的地点搜索结果，请先检索。'), details: { ok: false } };
      }
      if (outcome.pool.length >= MAX_OVERVIEW_POIS) {
        return { content: text(`候选池已满（${MAX_OVERVIEW_POIS} 条），请停止添加，调用 submit_research 收尾。`), details: { ok: false } };
      }
      const identityRef = { name, ...(known ? { canonicalPlaceId: canonicalPlaceId(known) } : {}) };
      const dup = outcome.pool.find((p) => samePlaceReference(p, identityRef));
      if (dup) {
        return { content: text(`「${name}」已在候选池中（${CATEGORY_LABEL[dup.category]}类），无需重复添加。`), details: { ok: false } };
      }

      const sourceLinks = (deps.groundedOnly ? [] : params.sourceLinks ?? [])
        .map((s) => ({ title: (s.title ?? '').trim().slice(0, 100), url: (s.url ?? '').trim().slice(0, 300) }))
        .filter((s) => s.title && isHttpUrl(s.url));

      const poi: ResearchPoi = {
        id: uid(),
        ...identityRef,
        name,
        category,
        intro: purifiedIntro(known?.payload) ?? cleanResearchIntro(params.intro),
        ...normalizeReservation(params.reservation, params.reservationNote),
        sourceLinks: [...purifiedIntroSources(known?.payload), ...sourceLinks],
      };
      if (deps.groundedOnly && !known && poiSource.kind === 'amap') {
        poi.sourceLinks.push({ title: '高德地点搜索', url: 'https://lbs.amap.com/' });
      }

      // 营业时间自动回填：同名命中 search_pois 捕获的 opentime 原文（仅 attraction 参与闭馆日检测）
      if (category === 'attraction') {
        // 契约限长 60（ResearchPoiSchema）；高德原文可能很长，概览卡只需要可读的营业时间。
        const openTime = (openTimeByName.get(name) ?? renderOpenHours(known?.payload?.openHours))?.trim();
        if (openTime) poi.openTime = openTime.slice(0, 60);
      }
      if (known && typeof known.lat === 'number' && typeof known.lng === 'number') {
        // 库内坐标是权威值，直接覆盖同名的搜索结果坐标。这里不能走 rememberResearchLocation：
        // 它的歧义检测是给「多个搜索结果撞名」用的，把库内坐标传进去会因坐标不一致而删掉整个 key，
        // 连搜索结果坐标一起丢，层2 坐标旁路随即失效。有效坐标守卫与旧调用保持一致。
        const libraryPoint = { lat: known.lat, lng: known.lng,
          adcode: typeof known.payload?.adcode === 'string' ? known.payload.adcode : '' };
        const locationKey = name.trim();
        if (locationKey && isUsableResearchLocation(libraryPoint)) {
          ambiguousNames.delete(locationKey);
          outcome.locations.set(locationKey, libraryPoint);
        }
      }

      // 图片只走高德 POI（2026-11-05 收敛）：search_pois 旁路 → 库内回写 → 实时查询。
      // 只补 attraction，food/hotel 的 POI 图命中差，前端回落类目图标。命中留空则前端占位。
      if (category === 'attraction') {
        const cover = await resolveCover(name, destination, {
          amapPhotos,
          storedAmapPhoto,
          saveAmapPhoto,
          searchPhotos: (coverName) => photoUrlsByName.get(normalizePlaceKey(coverName)),
        });
        if (cover) Object.assign(poi, cover);
      }

      // 预约种子表命中即置信：强制覆盖三态与说明，并把官方渠道链接放到来源首位
      const identity = known?.payload?.identity as { kind?: string } | undefined;
      const seed = category === 'attraction' && identity?.kind !== 'complex' ? matchReservationSeed(name) : null;
      if (seed) {
        poi.reservation = 'required';
        poi.reservationNote = seed.note.slice(0, 120);
        poi.sourceLinks = [
          { title: `${seed.name}（官方渠道）`, url: seed.sourceUrl },
          ...poi.sourceLinks.filter((s) => s.url !== seed.sourceUrl),
        ];
      }

      // 小红书社区库命中（PG，xhs-travel-pipeline 导入）：种子表未覆盖时补充真实预约政策 + 社区口碑来源
      const xhs = known ? null : await findXhsPlace(name, destination);
      if (xhs) {
        poi.intro = purifiedIntro(xhs.payload) ?? poi.intro;
        const contentSources = purifiedIntroSources(xhs.payload);
        poi.sourceLinks = [...poi.sourceLinks.slice(0, seed ? 1 : 0), ...contentSources,
          ...poi.sourceLinks.slice(seed ? 1 : 0)];
        if (!seed) Object.assign(poi, normalizeReservation(xhs.payload.reservation, xhs.payload.reservationNote));
        const evidence = await findXhsEvidence(xhs.id, [], 4);
        for (const item of evidence) {
          if (!isHttpUrl(item.sourceUrl)) continue;
          if (poi.sourceLinks.length >= MAX_SOURCE_NOTES) break;
          if (poi.sourceLinks.some((s) => s.url === item.sourceUrl)) continue;
          poi.sourceLinks.push({ title: `小红书社区口碑｜${xhs.name}`, url: item.sourceUrl });
        }
      }
      if (known) {
        // 结构化数据也可能自相矛盾：先校验再复用，官方种子仍优先。
        if (!seed) Object.assign(poi, normalizeReservation(known.payload?.reservation, known.payload?.reservationNote));
        for (const item of known.evidence) {
          if (item.sourceUrl && isHttpUrl(item.sourceUrl) && !poi.sourceLinks.some((source) => source.url === item.sourceUrl)) {
            poi.sourceLinks.push({ title: `${known.name}｜${item.kind}`, url: item.sourceUrl });
          }
        }
      }
      poi.sourceLinks = poi.sourceLinks.slice(0, MAX_SOURCE_NOTES);

      deps.signal?.throwIfAborted();
      outcome.pool.push(poi);
      onCandidate?.(poi);
      const nthOfCategory = outcome.pool.filter((p) => p.category === category).length;
      return {
        content: text(
          `已加入候选池（${CATEGORY_LABEL[category]}类第 ${nthOfCategory} 个）：${name}${seed ? '（命中预约种子表，已标注需预约）' : ''}`,
        ),
        details: { ok: true, id: poi.id, category, seedHit: Boolean(seed) },
      };
    },
  });

  const submitTool = defineTool({
    name: 'submit_research',
    label: '提交调研结果',
    description: '一次写入所有选中的已验证地点并结束调研。每项只填 placeId 和短 intro，系统复用名称、类别、预约与来源；无需先逐条 add_candidate。仅外部地点已全部入池时可省略 candidates。',
    executionMode: 'sequential',
    parameters: Type.Object({
      candidates: Type.Optional(Type.Array(Type.Object({
        placeId: Type.String({ minLength: 1, description: '系统预取或 search_verified_places 返回的原始 id' }),
        intro: Type.String({ minLength: 1, maxLength: 200, description: '120～180字完整介绍；有上游提纯简介时可直接复用，勿改写事实、数量和限定语' }),
      }), { minItems: 1, maxItems: MAX_OVERVIEW_POIS })),
      summary: Type.Optional(Type.String({ description: '可省略；只写未满足要求或来源限制，不编排路线、不重复候选' })),
    }),
    execute: async (_id, params) => {
      deps.signal?.throwIfAborted();
      const selected = new Map<string, { place: RetrievedPlace; intro: string }>();
      // 先验证整个批次，再调用既有入池逻辑；错误引用不能造成半批写入或提前结束。
      for (const item of params.candidates ?? []) {
        const place = knownPlaces.get(item.placeId);
        if (!place || !place.verified || place.city !== destination || placeCategory(place.category) === 'hotel'
          || (deps.acceptPlace && !deps.acceptPlace(place.name, place.aliases, canonicalPlaceId(place)))
          || (placeCategory(place.category) === 'food' && deps.foodSearch === false)) {
          return { content: text(`错误：候选 id=${item.placeId} 不在本次可用地点中，请使用已检索的同城景点/美食 id。`), details: { ok: false } };
        }
        if (!item.intro.trim()) return { content: text(`错误：${place.name} 的 intro 不能为空。`), details: { ok: false } };
        const key = canonicalPlaceId(place);
        if (!selected.has(key)) selected.set(key, { place, intro: item.intro });
      }
      const pending = uniquePlaceReferences([...selected.values()].map(item => ({ ...item,
        name: item.place.name, canonicalPlaceId: canonicalPlaceId(item.place) })))
        .filter((item) => !outcome.pool.some((poi) => samePlaceReference(poi, item)));
      if (outcome.pool.length + pending.length > MAX_OVERVIEW_POIS) {
        return { content: text(`错误：候选总数超过 ${MAX_OVERVIEW_POIS}，请减少提交数量。`), details: { ok: false } };
      }
      if (!outcome.pool.length && !pending.length) {
        return { content: text('错误：候选池为空，请先提交地点。'), details: { ok: false } };
      }
      for (const { place, intro } of pending) {
        deps.signal?.throwIfAborted();
        const result = await addTool.execute(_id, { placeId: place.id, name: place.name, category: placeCategory(place.category), intro });
        if (!result.details?.ok) return result;
      }
      deps.signal?.throwIfAborted();
      outcome.summary = params.summary?.trim().slice(0, 2000) || `已筛选 ${outcome.pool.length} 个候选地点。`;
      return {
        content: text(`调研结果已提交（候选池共 ${outcome.pool.length} 条）。`),
        details: { ok: true, length: outcome.summary.length, poolSize: outcome.pool.length },
        terminate: true,
      };
    },
  });

  return [verifiedTool, poisTool, webTool, addTool, submitTool];
}
