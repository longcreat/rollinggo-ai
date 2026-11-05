// 停留「分量」（09-22 决策 A）：不给分钟数，只给相对量级（1~3）。
//
// 为什么不用分钟数：上游 `payload.typicalVisitMinutes` 覆盖率仅 3.5%，而我们已不排时间轴 ——
// 分钟数的唯一用途就是判断「一天排不排得下」，那用相对量级就够了，不需要一层看起来精确的假数据。
// 数据源：`payload.xhsPlaceType`（1494/1494 全有），缺失时退 `canonical_places.category`（8 活动类目）。
//
// 用它守住的是「一天塞几个大点」：故宫(3) + 恭王府(3) + 雍和宫(3) 不该出现在同一天。
// 纯函数、零 IO —— 切段算法可单测的前提。

/** 大景区级：一天最多塞两个 */
const HEAVY_TYPES = new Set(['scenic_area']);

// 校准说明（09-22 实测）：`attraction` 是 catch-all 类型（占全部 POI 的 875/1494 = 59%），
// 给它 3 分等于把所有点都当大景区 —— 实测一天只剩 2 个、三天行程丢 8 个候选。
// 只有 `scenic_area`（真的风景区）才算 3；博物馆/公园/普通景点都算 2。
const WEIGHT_BY_PLACE_TYPE: Record<string, number> = {
  scenic_area: 3,
  attraction: 2,
  museum: 2,
  park: 2,
  business_area: 1,
  street: 1,
  market: 1,
  photo_spot: 1,
  cafe: 1,
  restaurant: 1,
  snack: 1,
  dessert: 1,
  food: 1,
  hotel: 0,
  other: 1,
};

/** 8 活动类目兜底（金集快照类候选只有这张表；数值比类型表保守一档） */
const WEIGHT_BY_CATEGORY: Record<string, number> = {
  文化: 2,
  自然: 2,
  娱乐: 2,
  美食: 1,
  购物: 1,
  交通: 1,
  其他: 1,
  住宿: 0,
};

export const DEFAULT_VISIT_WEIGHT = 2;

export interface VisitWeightFacts {
  /** payload.xhsPlaceType：细粒度地点类型 */
  placeType?: string;
  /** canonical_places.category：8 活动类目 */
  category?: string;
}

/** 停留分量：细粒度类型表 → 类目表 → 默认值 */
export function visitWeight(facts: VisitWeightFacts | undefined): number {
  const byType = facts?.placeType ? WEIGHT_BY_PLACE_TYPE[facts.placeType.toLowerCase()] : undefined;
  if (byType !== undefined) return byType;
  const byCategory = facts?.category ? WEIGHT_BY_CATEGORY[facts.category] : undefined;
  return byCategory ?? DEFAULT_VISIT_WEIGHT;
}

/** 是否「大点」（供测试与未来可能的差异化策略复用） */
export function isHeavy(placeType: string | undefined): boolean {
  return Boolean(placeType && HEAVY_TYPES.has(placeType.toLowerCase()));
}
