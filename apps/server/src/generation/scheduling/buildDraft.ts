// 排程结果 → DraftTrip 落盘（第二期）：把纯函数排出的序列写成草稿活动。
// 活动说明直接复用候选 intro；后续 writer 只写行程与每日标题，不改活动说明。
// 坐标直接用调研阶段旁路捕获的真实坐标（GCJ-02），标 coordSource='geocoded' 让 geoPipeline 跳过重解析。
import {
  ACTIVITY_CATEGORIES,
  MAX_SOURCE_NOTES,
  uniquePlaceReferences,
  type ActivityCategory,
  type GenerateForm,
  type ResearchPoi,
} from '@tripweaver/shared';
import type { DraftTrip } from '../draft';
import { createResearchPlaceLookup, type ResearchLocation } from '../placeLookup';
import { routeOrderConstraints } from '../../data/routeOrderSeeds';
import type { LongHaulPoi } from '../longHaul';
import { buildSchedule, ScheduleDateConflictError, type ScheduleResult, type SchedulablePoi } from './schedule';
import { poiScore, scoreMaxima } from './score';
import { visitWeight } from './visitWeight';
import { type PlaceFacts } from './placeFacts';
import { resolveRelatedPairs, type PlaceRelations } from './placeRelations';

export interface ScheduleDraftInput {
  draft: DraftTrip;
  form: GenerateForm;
  pool: readonly ResearchPoi[];
  locations: ReadonlyMap<string, ResearchLocation>;
  longHaul: readonly LongHaulPoi[];
  foodFocused: boolean;
  facts: ReadonlyMap<string, PlaceFacts>;
  /** POI 无向关联对（09-27，来自 place_relation 表）：成链时给强关联的两点距离打折，让它们更可能同天 */
  relations: PlaceRelations;
}

export interface ScheduleDraftResult {
  schedule: ScheduleResult;
  /** 写入草稿的活动数（含餐次与占位） */
  written: number;
  /** 无坐标候选数：不参与空间聚类，但照样排入（按分数轮流补位），坐标留给 geoPipeline 后续解析 */
  withoutCoord: number;
}

/** 草稿活动类目：餐饮固定「美食」；占位固定「其他」；其余优先用知识库的 8 类目，否则按候选类目回退 */
function activityCategory(poi: SchedulablePoi, facts: PlaceFacts | undefined): ActivityCategory {
  if (poi.category === 'food') return '美食';
  if (poi.category === 'other') return '其他';
  const fromKnowledgeBase = facts?.category;
  if (fromKnowledgeBase && (ACTIVITY_CATEGORIES as readonly string[]).includes(fromKnowledgeBase)) {
    return fromKnowledgeBase as ActivityCategory;
  }
  return poi.category === 'hotel' ? '住宿' : '文化';
}

interface LocatedPoi {
  poi: ResearchPoi;
  /** 调研阶段旁路捕获的坐标；可缺省（后续由 geoPipeline 解析） */
  point?: ResearchLocation;
  facts: PlaceFacts | undefined;
}

/**
 * 确定性排程并写入草稿。
 * 排除规则：hotel 不排成活动（住宿只用表单/推导出的区域名）。
 * 无坐标候选不排除 —— 既有设计里活动坐标由 geoPipeline 在排程之后统一解析，
 * 排程不能因为「调研阶段没抓到坐标」就把好候选丢掉。
 */
export function applyDeterministicSchedule(input: ScheduleDraftInput): ScheduleDraftResult {
  const lookup = createResearchPlaceLookup(input.pool, input.locations);
  const located: LocatedPoi[] = [];
  let withoutCoord = 0;
  for (const poi of uniquePlaceReferences(input.pool)) {
    const { point } = lookup({ name: poi.name, poiId: poi.id });
    const facts = input.facts.get(poi.name.trim());
    // 坐标优先取调研阶段捕到的高德值；没有则用 canonical_places 的坐标兜底
    // （库内 1494/1494 都有，且实测与高德同坐标系：点状地标偏差 64~93m）。
    // 这条兜底让排程不再依赖「模型多调 search_pois」——高德留给知识库没覆盖的地点与封面图。
    const coords =
      point ??
      (facts?.lat !== undefined && facts.lng !== undefined
        ? { lat: facts.lat, lng: facts.lng, adcode: facts.adcode ?? '' }
        : undefined);
    // 住宿不进编排（09-22）：既不排成活动，也不梯推导住宿区域。
    // 之前拿 hotel 候选的 name 当住宿区域名，必然产出具体商家（实测：「北京丽晶酒店」
    // 「观旗宾馆(北京天安门广场店)」），违反「只给区域名、严禁具体酒店」。
    if (poi.category === 'hotel') continue;
    if (!coords) withoutCoord += 1;
    located.push({ poi, ...(coords ? { point: coords } : {}), facts });
  }

  // 选点权重：社区推荐分（质量）0.6 + 提及次数（热度）0.4 + 金集加分。
  // 归一化基准只统计有值的样本；缺失值走中性比例（不当 0）—— 否则金集地标会被排到最后。
  const maxima = scoreMaxima(located.map((item) => item.facts));
  const points: SchedulablePoi[] = located.map(({ poi, point, facts }) => {
    const schedulable: SchedulablePoi = {
      id: poi.id,
      name: poi.name,
      category: poi.category,
      ...(point ? { lat: point.lat, lng: point.lng } : {}),
      score: poiScore(facts, maxima),
      weight: visitWeight(facts),
    };
    if (facts?.openTime) {
      // 社区结构化开闭馆（09-27）：上游 mine_open_hours 挖出的 closedWeekdays 是明确星期数字，
      // 排程能精确避让；优先级高于高德原文（高德常只给时段、不给闭馆日，无法避让）。
      schedulable.openTime = facts.openTime;
    } else if (poi.openTime) {
      schedulable.openTime = poi.openTime;
    } else if (facts?.closureText) {
      // 闭馆回填（09-23）：前两者都缺位时用 evidence 挖出的闭馆表述兜底（如「周一闭馆」）
      schedulable.openTime = facts.closureText;
    }
    const theme = facts?.themes[0];
    if (theme) schedulable.theme = theme;
    // 知识库的 8 活动类目：主题缺失时的回退标签（图片/街道类点上常常没有 themes）
    if (facts?.category) schedulable.kbCategory = facts.category;
    return schedulable;
  });

  const schedule = buildSchedule(points, {
    days: input.form.days,
    foodFocused: input.foodFocused,
    exclusiveNames: input.longHaul.filter((item) => item.tier === 'exclusive').map((item) => item.name),
    fallbackArea: input.form.destination,
    startDate: input.form.startDate || undefined,
    ...(input.form.pace ? { pace: input.form.pace } : {}),
    // 顺序种子表（09-23）：出入口方向等固定先后（故宫→景山），两端都在候选池才生效
    orderConstraints: routeOrderConstraints(input.form.destination, input.pool.map((p) => p.name)),
    // 关联对（09-27）：只做同天聚类的距离折扣，不产出先后约束（上游数据无向，不表达顺序）
    relatedPairs: resolveRelatedPairs(input.relations, input.pool),
  });

  if (schedule.closureConflicts.length) {
    throw new ScheduleDateConflictError(schedule.closureConflicts, schedule.dateRepair.reason);
  }

  input.draft.setSkeleton(
    `${input.form.destination}${input.form.days}日行程`,
    schedule.days.map((day) => day.title),
  );

  const byId = new Map(located.map((item) => [item.poi.id, item]));
  let written = 0;
  for (const day of schedule.days) {
    for (const stop of day.stops) {
      const source = byId.get(stop.poi.id);
      const mealLabel = stop.meal === 'lunch' ? '午餐' : '晚餐';
      // 周边就餐区域引用真实景点，不把周边区域名当门店查，也不将远郊餐次重定位到市中心。
      const synthetic = !source;
      const fallbackDescription = stop.meal
        ? '就近就餐的片区锚点；具体门店、价格与营业情况请到大众点评或美团确认。'
        : '本天空余时段，可按体力与天气就近安排。';
      const placeName = stop.areaAnchorName ?? (synthetic ? input.form.destination : stop.poi.name);
      const coord = stop.poi.lat !== undefined && stop.poi.lng !== undefined ? { lat: stop.poi.lat, lng: stop.poi.lng } : {};
      input.draft.addActivity(day.dayIndex, {
        name: stop.meal ? `${mealLabel}｜${stop.poi.name}` : stop.poi.name,
        placeName,
        ...(source ? { poiId: stop.poi.id } : {}),
        ...(source?.poi.canonicalPlaceId ? { canonicalPlaceId: source.poi.canonicalPlaceId } : {}),
        ...coord,
        // 有真实坐标（调研阶段旁路捕获的 GCJ-02）才标 geocoded；否则留给 geoPipeline 解析
        ...(stop.poi.lat !== undefined ? { coordSource: 'geocoded' as const, coordSystem: 'gcj02' as const } : {}),
        // 不产出时间轴（09-22 D5）：拿不到可信游玩时长，排「几点到几点」是假数据，
        // 而且真实 leg 会在后处理阶段把假时间轴一路推爆（实测第 2 天被推到 22:45）。
        // ActivitySchema 的 startTime/endTime 允许空串，前端按「未排时刻」展示。
        startTime: '',
        endTime: '',
        category: activityCategory(stop.poi, source?.facts),
        // 候选intro优先复用上游提纯完整介绍（≤200字），不再截成60字。
        // 无候选来源的合成活动（空天占位、无美食候选的餐次锚点）由代码给一句如实说明。
        // 有候选来源时即使 intro 为空也如实留空：替它编一句比空着更糟。
        description: source ? (source.poi.intro ?? '').trim().slice(0, 200) : fallbackDescription,
        // openTime 取排程侧的有效值（高德原文或 evidence 闭馆回填），不止 ResearchPoi 原始字段
        ...(stop.poi.openTime ? { openTime: stop.poi.openTime } : {}),
        ...(source?.poi.sourceLinks.length ? { sourceNotes: source.poi.sourceLinks.slice(0, MAX_SOURCE_NOTES) } : {}),
      });
      written += 1;
    }
  }

  return { schedule, written, withoutCoord };
}
