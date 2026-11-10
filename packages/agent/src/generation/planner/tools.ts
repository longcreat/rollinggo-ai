// 规划 Agent 的工具：片区发现、片区内真实 POI、网页资料、按天排点并定时、验收、提交。
//
// 约定：所有空间/时间数字来自工具（高德检索、启发式通勤、planDay），模型只做选择与取舍；
// 因此模型输出的行程不会出现「上午故宫下午八达岭」这类凭空距离。
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { GenerateForm, LegMode, PlanDayEventStop, PoiCategory } from '@tripweaver/shared';
import { effectiveLegMode } from '@tripweaver/shared';
import { DAILY_SIGHT_LIMITS, FEASIBILITY_THRESHOLDS } from '@tripweaver/shared';
import { defineTool } from '../tools/defineTool';
import type { DraftTrip } from '../draft';
import type { GeoPoint, SourcedPoi } from '@tripweaver/integrations/geoContracts';
import { searchAreaPlacesCore, webSearchCore, type AreaAccess, type WebAccess } from '../../agent/tools/dataTools';
import { estimateLeg } from '../legEstimator';
import { optimizeRouteOrder } from '../scheduling/routeOrder';
import { planDay, parseClock, type PlanDayStop } from '../scheduling/dayPlanner';
import { dayDate, measurePlan, planViolations, PLAN_POLICY, type PlanPace, type PlanViolation } from './validator';

export interface PlannerSeed {
  name: string;
  lat: number;
  lng: number;
  intro?: string;
  category?: PoiCategory;
  openTime?: string;
  canonicalPlaceId?: string;
}

export interface PlannerArea {
  id: string;
  name: string;
  center: GeoPoint;
  radiusM: number;
  members: PlannerSeed[];
}

export interface PlannerDeps {
  form: GenerateForm;
  draft: DraftTrip;
  areas: readonly PlannerArea[];
  /** 片区检索（高德周边/多边形），由 orchestrator 注入并计配额。 */
  searchArea(query: { center: GeoPoint; radiusM: number; keywords?: string }, signal: AbortSignal): Promise<SourcedPoi[]>;
  /** 网页检索（复用同一轮 search source 与日额度）。 */
  webSearch(query: string, signal: AbortSignal, options?: { topic?: 'general' | 'news'; days?: number }): Promise<{ title: string; url: string; summary: string }[]>;
  /** 每天排完后回调（直播页据此逐日长出行程与地图点位）。 */
  onDayPlanned?(day: { dayIndex: number; title?: string; stops: PlanDayEventStop[] }): void;
  signal: AbortSignal;
}

interface PoolItem {
  name: string;
  lat: number;
  lng: number;
  type?: string;
  address?: string;
  intro?: string;
  category: PoiCategory;
  openTime?: string;
  canonicalPlaceId?: string;
}

const MAX_AREAS = 8;
const AREA_RADIUS_M = 2_500;
const AREA_SEARCH_CAP = 12;
const WEB_SEARCH_CAP = 4;
const MAX_STOPS = 10;

/**
 * 候选池类目 → 活动类目：food/hotel 透传真实类目，attraction 落「文化」
 * （规划链只检索景点，种子/检索结果带不出自然/娱乐这类更细的中文类目）。
 */
function activityCategory(category: PoiCategory): '文化' | '美食' | '住宿' {
  return category === 'food' ? '美食' : category === 'hotel' ? '住宿' : '文化';
}

/** 把候选按距离聚成片区（单链：与任一成员在 2.5km 内即同片区）。 */
export function buildAreas(seeds: readonly PlannerSeed[], radiusM = AREA_RADIUS_M, maxAreas = MAX_AREAS): PlannerArea[] {
  const areas: PlannerArea[] = [];
  const seen = new Set<string>();
  const meters = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => Math.hypot(
    (a.lat - b.lat) * 111_320,
    (a.lng - b.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180),
  );
  for (const seed of seeds) {
    const name = seed.name.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const target = areas.find((area) => area.members.some((member) => meters(member, seed) <= radiusM));
    if (target) {
      target.members.push(seed);
      target.center = {
        lat: target.members.reduce((sum, item) => sum + item.lat, 0) / target.members.length,
        lng: target.members.reduce((sum, item) => sum + item.lng, 0) / target.members.length,
      };
    } else if (areas.length < maxAreas) {
      areas.push({ id: `area-${areas.length + 1}`, name, center: { lat: seed.lat, lng: seed.lng }, radiusM, members: [seed] });
    }
  }
  return areas;
}

function text(value: string) {
  return [{ type: 'text' as const, text: value }];
}

function validPoint(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

function contentText(value: unknown): string {
  const content = (value as { content?: { type?: string; text?: string }[] })?.content;
  return Array.isArray(content) ? content.find((item) => typeof item?.text === 'string')?.text ?? '' : '';
}

function draftMetrics(deps: PlannerDeps) {
  // 与线上验收同源：直接用草稿的 Trip 投影，而不是手搓假对象——
  // 旧版把任意类目强转成 '文化'（餐次被当成可停留景点计入 stopsPerDay）且 legs 传空。
  const trip = deps.draft.toTrip();
  return measurePlan({ startDate: trip.startDate, days: trip.days });
}

/** 当前草稿的违规清单：validate_plan 与 submit_plan 必须用同一份口径，避免「验收通过、提交被拦」。 */
function planViolationsForDraft(deps: PlannerDeps): PlanViolation[] {
  const days = deps.draft.mutableDays();
  return planViolations(draftMetrics(deps), PLAN_POLICY[(deps.form.pace ?? 'moderate') as PlanPace] ?? PLAN_POLICY.moderate, days.length);
}

export function buildPlannerTools(deps: PlannerDeps): AgentTool[] {
  const pool = new Map<string, PoolItem>();
  for (const area of deps.areas) {
    for (const member of area.members) {
      if (!validPoint(member.lat, member.lng)) continue;
      pool.set(member.name, {
        name: member.name, lat: member.lat, lng: member.lng, intro: member.intro,
        category: member.category ?? 'attraction', openTime: member.openTime, canonicalPlaceId: member.canonicalPlaceId,
      });
    }
  }
  let areaCalls = 0;
  let webCalls = 0;
  let submitted = false;
  const mode = (deps.form.transportMode ?? 'transit') as LegMode;

  const ensureDays = () => {
    const days = deps.draft.mutableDays();
    if (days.length !== deps.form.days) deps.draft.setSkeleton(`${deps.form.destination}${deps.form.days}日行程`, Array.from({ length: deps.form.days }, () => ''));
  };

  const listAreas = defineTool({
    name: 'list_areas',
    label: '查看片区',
    description: '列出系统按距离聚出的片区：中心、半径、已有候选。先调用它，再决定每天用哪个片区。',
    parameters: Type.Object({}),
    execute: async () => {
      const rows = deps.areas.map((area) => ({
        id: area.id, name: area.name,
        center: { lat: Number(area.center.lat.toFixed(5)), lng: Number(area.center.lng.toFixed(5)) },
        radiusM: area.radiusM, candidates: area.members.map((member) => member.name).slice(0, 12),
      }));
      return { content: text(JSON.stringify({ areas: rows })), details: { count: rows.length } };
    },
  });

  // 片区检索与全网搜索：核心实现与主 Agent 共用（agent/tools/dataTools），这里只做 SDK 包装。
  const plannerAreaAccess: AreaAccess = {
    signal: deps.signal,
    async resolve({ area, areaId }) {
      const found = areaId
        ? deps.areas.find((item) => item.id === areaId)
        : deps.areas.find((item) => item.name === area);
      if (!found) return { ok: false, error: `错误：未知片区 ${areaId ?? area}，先调 list_areas` };
      return { ok: true, area: { name: found.name, center: found.center, radiusM: found.radiusM } };
    },
    async search({ center, radiusM, keywords }) {
      if (areaCalls >= AREA_SEARCH_CAP) return { ok: false, error: '错误：本轮片区检索次数已用完，请用已有候选并 submit_plan' };
      areaCalls += 1;
      try {
        return { ok: true, pois: await deps.searchArea({ center, radiusM, ...(keywords ? { keywords } : {}) }, deps.signal) };
      } catch (error) {
        return { ok: false, error: `片区检索失败：${error instanceof Error ? error.message : '未知错误'}；可换片区或用已有候选` };
      }
    },
    accept(pois) {
      for (const poi of pois) {
        const location = poi.location!;
        pool.set(poi.name, {
          name: poi.name, lat: location.lat, lng: location.lng, type: poi.type, address: poi.address,
          category: 'attraction', openTime: poi.opentime,
        });
      }
    },
  };
  const areaCore = searchAreaPlacesCore(plannerAreaAccess);
  const searchAreaPlaces = defineTool({
    name: areaCore.name,
    label: '检索片区点位',
    description: areaCore.description,
    parameters: areaCore.parameters as never,
    execute: async (_id, params) => {
      const result = await areaCore.run(params as Record<string, unknown>);
      return { content: text(result.text), details: result.details ?? {}, ...(result.isError ? { isError: true } : {}) };
    },
  });

  const plannerWebAccess: WebAccess = {
    signal: deps.signal,
    async search(query, options) {
      if (webCalls >= WEB_SEARCH_CAP) return { ok: false, error: '错误：本轮联网检索次数已用完，请直接规划或提交' };
      webCalls += 1;
      try {
        return { ok: true, hits: await deps.webSearch(query, deps.signal, options) };
      } catch (error) {
        return { ok: false, error: `联网检索失败：${error instanceof Error ? error.message : '未知错误'}` };
      }
    },
  };
  const webCore = webSearchCore(plannerWebAccess);
  const webSearch = defineTool({
    name: webCore.name,
    label: '搜索攻略',
    description: webCore.description,
    parameters: webCore.parameters as never,
    execute: async (_id, params) => {
      const result = await webCore.run(params as Record<string, unknown>);
      return { content: text(result.text), details: result.details ?? {}, ...(result.isError ? { isError: true } : {}) };
    },
  });

  const planDayTool = defineTool({
    name: 'plan_day',
    label: '排定一天',
    description: '为某一天选点并生成时刻：工具会把 places 重排为顺路顺序、计算通勤、检查闭馆，然后写入当天。重复调用会覆盖该天。',
    parameters: Type.Object({
      dayIndex: Type.Integer({ minimum: 1, description: '第几天，从 1 开始' }),
      areaId: Type.String({ description: '主要片区 id（用于提示）' }),
      places: Type.Array(Type.String(), { minItems: 2, maxItems: MAX_STOPS, description: '按希望游玩的顺序给出地点名，必须来自 list_areas 候选或 search_area_places 结果' }),
      startAt: Type.Optional(Type.String({ description: '第一个活动的到达时刻 HH:mm，默认 09:00' })),
    }),
    execute: async (_id, params) => {
      deps.signal.throwIfAborted();
      if (params.dayIndex < 1 || params.dayIndex > deps.form.days) {
        return { content: text(`错误：dayIndex 必须在 1..${deps.form.days}`), isError: true, details: {} };
      }
      ensureDays();
      const unknown = params.places.filter((name) => !pool.has(name.trim()));
      if (unknown.length) {
        return { content: text(`错误：以下地点不在候选内：${unknown.join('、')}。先用 search_area_places 查到再加入。`), isError: true, details: {} };
      }
      const unique = [...new Set(params.places.map((name) => name.trim()))].slice(0, MAX_STOPS);
      const stops: PlanDayStop[] = unique.map((name) => {
        const item = pool.get(name)!;
        // 类目用中文活动类目：planDay 的餐时窗（dwellMinutes 的「美食」分支）与写入草稿共用一套口径
        return { id: name, name, lat: item.lat, lng: item.lng, category: activityCategory(item.category), ...(item.openTime ? { openTime: item.openTime } : {}) };
      });
      const ordered = optimizeRouteOrder(stops).map((stop) => stop.name);
      const orderedStops = ordered.map((name) => stops.find((stop) => stop.name === name)!).filter(Boolean);
      const requestedStart = /^\d{1,2}:\d{2}$/.test(params.startAt ?? '') ? params.startAt! : '09:00';
      // startAt 是当天首个活动的到达时刻：晚于 10:00 会把一天拖到午夜后（实测 23:14 出发 → 次日 00:29 结束）。
      const startAt = (parseClock(requestedStart) ?? 9 * 60) > 10 * 60 ? '09:00' : requestedStart;
      const pace = (deps.form.pace ?? 'moderate') as PlanPace;
      const sightMax = DAILY_SIGHT_LIMITS[pace].max;
      // 餐次由后处理插入（约 1h/餐）；美食偏好时预留两餐，避免排完刚好顶到 14h 上限。
      const mealReserveMin = (deps.form.preferences ?? []).includes('美食') ? 2 * 60 : 0;
      // 与 geoPipeline 的真实 legs 同口径：短距离自动降为步行/骑行，避免 plan_day 用基础模式高估通勤、
      // 让模型据此做出错误的顺路排序。
      const travelMinutes = async (from: PlanDayStop, to: PlanDayStop) =>
        estimateLeg(from, to, effectiveLegMode(from, to, mode)).durationMin;
      const planStops = (stops: PlanDayStop[]) => planDay({
        dayIndex: params.dayIndex,
        startDate: deps.form.startDate ?? '',
        startAt,
        pace,
        stops,
        travelMinutes,
      });

      // 越过每日上限时**确定性裁剪**（按模型给出的顺序保留前 N 个），而不是返回错误逼模型重试：
      // 实测反复拒绝会把轮次烧满导致整单失败。闭馆仍交给模型换点。
      let selected = orderedStops.slice(0, sightMax);
      let plan = await planStops(selected);
      while (plan.totalMinutes + mealReserveMin > FEASIBILITY_THRESHOLDS.hardDayTotalMin && selected.length > 2) {
        selected = selected.slice(0, -1);
        plan = await planStops(selected);
      }

      // 闭馆是硬冲突：不能替模型决定换哪个点。
      const closures = plan.issues.filter((issue) => issue.includes('闭馆'));
      if (closures.length) {
        return {
          content: text(`错误：${closures.join('；')}。请换掉闭馆地点后重新 plan_day（同一天可先用已候选里的其它点）。`),
          isError: true,
          details: { closures: closures.length },
        };
      }
      const trimmed = orderedStops.length - selected.length;

      const day = deps.draft.mutableDays()[params.dayIndex - 1]!;
      day.activities.length = 0;
      const timed = new Map(plan.timed.map((item) => [item.id, item]));
      for (const stop of selected) {
        const item = pool.get(stop.name)!;
        const slot = timed.get(stop.name);
        deps.draft.addActivity(params.dayIndex, {
          name: stop.name,
          placeName: stop.name,
          lat: item.lat,
          lng: item.lng,
          coordSource: 'geocoded',
          coordSystem: 'gcj02',
          category: activityCategory(item.category),
          ...(item.intro ? { description: item.intro.slice(0, 200) } : item.type ? { description: `${item.type}${item.address ? ` · ${item.address}` : ''}`.slice(0, 200) } : {}),
          ...(item.openTime ? { openTime: item.openTime } : {}),
          ...(item.canonicalPlaceId ? { canonicalPlaceId: item.canonicalPlaceId } : {}),
          startTime: slot?.arrive ?? '',
          endTime: slot?.leave ?? '',
        });
      }
      deps.onDayPlanned?.({
        dayIndex: params.dayIndex,
        stops: selected.map((stop) => {
          const item = pool.get(stop.name)!;
          const slot = timed.get(stop.name);
          return {
            name: stop.name, lat: item.lat, lng: item.lng,
            startTime: slot?.arrive ?? '', endTime: slot?.leave ?? '', category: activityCategory(item.category),
          };
        }),
      });
      return {
        content: text(JSON.stringify({
          dayIndex: params.dayIndex,
          itinerary: plan.timed.map((item) => ({ name: item.name, arrive: item.arrive, leave: item.leave, travelMin: item.travelMin })),
          endAt: plan.endAt,
          issues: plan.issues,
          ...(trimmed ? { trimmedTo: selected.length } : {}),
        })),
        details: { stops: selected.length, issues: plan.issues.length, trimmed },
      };
    },
  });

  const validate = defineTool({
    name: 'validate_plan',
    label: '验收方案',
    description: '检查当前草稿：每天景点数、段距、重复坐标、杂项与闭馆冲突。返回违规清单，按提示修正后再提交。',
    parameters: Type.Object({}),
    execute: async () => {
      const days = deps.draft.mutableDays();
      const metrics = draftMetrics(deps);
      const violations = planViolationsForDraft(deps);
      return {
        content: text(JSON.stringify({
          days: days.map((day, index) => ({
            dayIndex: index + 1,
            stops: metrics.stopsPerDay[index + 1] ?? 0,
            date: dayDate(deps.form.startDate ?? '', index + 1),
          })),
          metrics: {
            hopKm: metrics.hopKm,
            dupCoordPairs: metrics.dupCoordPairs,
            junkRatio: metrics.junkRatio,
            zeroLegShare: metrics.zeroLegShare,
            closureViolations: metrics.closureViolations,
          },
          violations,
        })),
        details: { violations: violations.length },
      };
    },
  });

  const submit = defineTool({
    name: 'submit_plan',
    label: '提交方案',
    description: '提交当前方案并结束规划。提交前确保每天都已 plan_day 且有活动。',
    parameters: Type.Object({ notes: Type.Optional(Type.String({ description: '一句规划说明，可选' })) }),
    execute: async (_id, params) => {
      const empty = deps.draft.mutableDays().findIndex((day) => day.activities.length === 0);
      if (empty >= 0) return { content: text(`错误：第 ${empty + 1} 天还没有活动，先 plan_day`), isError: true, details: {} };
      // 提交前再拦一次闭馆：模型可能没理会 plan_day 的 issues，最后一道硬冲突不能带进落库。
      const closings = planViolationsForDraft(deps).filter((violation) => violation.code === 'closure');
      if (closings.length) {
        return {
          content: text(`错误：${closings.map((violation) => violation.detail).join('；')}。请换掉闭馆地点后重新 plan_day。`),
          isError: true,
          details: { closures: closings.length },
        };
      }
      submitted = true;
      return { content: text(`已提交${params.notes ? `：${params.notes}` : ''}`), details: { submitted: true } };
    },
  });

  return [listAreas, searchAreaPlaces, webSearch, planDayTool, validate, submit];
}

/** 工具集与 completion 共享同一个 submitted 标志：由 buildPlannerTools 暴露读取器。 */
export function buildPlannerToolsWithStatus(deps: PlannerDeps): { tools: AgentTool[]; isSubmitted(): boolean; toolText(value: unknown): string } {
  const tools = buildPlannerTools(deps);
  const submitTool = tools.find((tool) => tool.name === 'submit_plan');
  if (!submitTool) throw new Error('缺少 submit_plan 工具');
  const original = submitTool.execute;
  let submitted = false;
  submitTool.execute = async (...args) => {
    const result = await original(...args);
    if (!(result as { isError?: boolean }).isError) submitted = true;
    return result;
  };
  ensureDaysForStatus(deps);
  return { tools, isSubmitted: () => submitted, toolText: contentText };
}

function ensureDaysForStatus(deps: PlannerDeps) {
  const days = deps.draft.mutableDays();
  if (days.length !== deps.form.days) deps.draft.setSkeleton(`${deps.form.destination}${deps.form.days}日行程`, Array.from({ length: deps.form.days }, () => ''));
}
