// 餐次充实（2026-11-06）：把排程产出的「片区锚点」餐次替换为真实餐厅。
//
// 为什么需要：buildDraft 在找不到合适美食候选时落合成锚点（「午餐｜成都」+ 请到大众点评确认），
// 因为调研阶段是景点导向的，池里带坐标且在当日动线 2km 内的美食候选很少。用户看到的
// 就是一排模糊餐次。这里在坐标解析之后、通勤腿计算之前，对每个锚点做一次**定向片区搜索**：
// 以当天相邻活动为关键词与中心，2km 内命中真实餐厅即替换（与 schedule.ts 的 mealNearbyKm 同口径）。
//
// 纪律：只替换合成锚点（description 前缀匹配），已有真实候选的餐次不动；命中必须带坐标、
// 当天不闭馆、不与当天活动重名；搜索次数有硬上限（预算友好），查不到就保留锚点（现状降级）。
import { dateForDayIndex, haversineMeters, isClosedOnDate } from '@rollinggo-trip/shared';
import type { PoiSource } from '@rollinggo-trip/integrations/geoContracts';
import type { DraftTrip } from './draft';
import { isMeal, MEAL_ANCHOR_ID_PREFIX } from './mealPlanning';

/** 单次生成最多几次餐次搜索（place 服务日预算才是硬闸门，这里是礼貌上限） */
export const MEAL_ENRICH_MAX_CALLS = 6;
/** 与 schedule.ts mealNearbyKm=2 同口径 */
const MEAL_NEARBY_METERS = 2000;
/** buildDraft 合成锚点的说明前缀：识别锚点的唯一依据 */
const ANCHOR_DESC_PREFIX = '就近就餐的片区锚点';

export interface MealEnrichResult {
  replaced: number;
  kept: number;
  notes: string[];
}

function hasCoord(a: { lat?: number; lng?: number }): boolean {
  return typeof a.lat === 'number' && typeof a.lng === 'number' && (a.lat !== 0 || a.lng !== 0);
}

export async function enrichMealAnchors(input: {
  draft: DraftTrip;
  poi: PoiSource;
  destination: string;
  startDate: string;
  signal: AbortSignal;
  maxCalls?: number;
  onProgress?: (text: string) => void;
}): Promise<MealEnrichResult> {
  const { draft, poi, destination, startDate, signal } = input;
  const maxCalls = input.maxCalls ?? MEAL_ENRICH_MAX_CALLS;
  let calls = 0;
  let replaced = 0;
  let kept = 0;
  const notes: string[] = [];

  const days = draft.mutableDays();
  for (let di = 0; di < days.length; di++) {
    const day = days[di]!;
    const dayIndex = di + 1;
    const date = dateForDayIndex(startDate, dayIndex) ?? undefined;
    for (let ai = 0; ai < day.activities.length; ai++) {
      const activity = day.activities[ai]!;
      const kind = isMeal(activity, 'lunch') ? 'lunch' : isMeal(activity, 'dinner') ? 'dinner' : null;
      if (!kind) continue;
      // 只替换合成锚点；真实候选（调研池带来的餐厅）原样保留。
      // 锚点判定：旧 buildDraft 的说明前缀，或确定性补齐（ensureMealCoverage）落下的 id 前缀。
      const synthetic = activity.description.startsWith(ANCHOR_DESC_PREFIX) || activity.id.startsWith(MEAL_ANCHOR_ID_PREFIX);
      if (!synthetic) { kept += 1; continue; }
      if (calls >= maxCalls) { kept += 1; continue; }
      // 顺路就近策略：优先以紧邻的前一个非就餐且有坐标的活动为中心；
      // 若前置无活动（例如餐次排在当天首站），则取紧邻的后一个活动为中心。
      const prevNeighbor = day.activities
        .slice(0, ai)
        .reverse()
        .find((a) => !isMeal(a, 'lunch') && !isMeal(a, 'dinner') && hasCoord(a));
      const nextNeighbor = day.activities
        .slice(ai + 1)
        .find((a) => !isMeal(a, 'lunch') && !isMeal(a, 'dinner') && hasCoord(a));
      const center = prevNeighbor ?? nextNeighbor;
      if (!center) { kept += 1; continue; }   // 当天没有可定位的参照活动，锚点坐标也无从谈起

      calls += 1;
      signal.throwIfAborted();
      const label = kind === 'lunch' ? '午餐' : '晚餐';
      let hits: Awaited<ReturnType<PoiSource['searchPois']>> = [];
      try {
        hits = await poi.searchPois('food', `${center.name} 美食`, destination, signal);
      } catch {
        hits = [];   // 搜索失败 = 保留锚点（生成不失败原则）
      }
      signal.throwIfAborted();
      // 筛选有效命中并在 2km 范围内寻找最优顺路餐厅：
      // 有前后两站时，优先选择最小化 (前站→餐厅 + 餐厅→后站) 总距离的店，避免折返跑。
      const validHits = hits.filter((hit) =>
        hit.location !== null
        && haversineMeters(center, hit.location) <= MEAL_NEARBY_METERS
        && !isClosedOnDate(hit.opentime, date)
        && !day.activities.some((a) => a.name.includes(hit.name) || hit.name.includes(a.name)));
      
      const pick = validHits.sort((a, b) => {
        const distA = haversineMeters(center, a.location!) + (nextNeighbor && hasCoord(nextNeighbor) ? haversineMeters(a.location!, nextNeighbor) : 0);
        const distB = haversineMeters(center, b.location!) + (nextNeighbor && hasCoord(nextNeighbor) ? haversineMeters(b.location!, nextNeighbor) : 0);
        return distA - distB;
      })[0];

      if (!pick || !pick.location) { kept += 1; continue; }

      day.activities[ai] = {
        ...activity,
        name: `${label}｜${pick.name}`.slice(0, 100),
        placeName: pick.name,
        description: ([pick.type, pick.address].filter(Boolean).join('；') || activity.description).slice(0, 200),
        lat: pick.location.lat,
        lng: pick.location.lng,
        coordSource: 'geocoded',
        coordSystem: 'gcj02',
        category: '美食',
        ...(pick.opentime ? { openTime: pick.opentime.slice(0, 60) } : {}),
      };
      replaced += 1;
      notes.push(`第 ${dayIndex} 天${label}：${pick.name}`);
      input.onProgress?.(`第 ${dayIndex} 天${label}找到了 ${pick.name}`);
    }
  }
  return { replaced, kept, notes };
}
