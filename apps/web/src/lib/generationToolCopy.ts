// 工具文案表（10-22）：生成进度里「正在…」的文案。
// key 必须用事件里的稳定工具名（GenerationEvent.tool_start.tool），不能用中文 label ——
// label 一改映射就静默失效，fallback 会把「查已验证地点库」这类内部术语直接暴露给用户。
// 分组与 apps/server/src/generation/tools/*.ts、orchestrator.ts 的 runSystemTask 保持一致。

/** 全部工具名（运行时清单 = 类型来源）：新增工具先加到这里，TOOL_COPY 漏配文案会被 tsc 拦下。 */
export const TOOL_NAMES = [
  // 调研 Agent
  'search_verified_places',
  'search_pois',
  'search_web',
  'add_candidate',
  'submit_research',
  // 行程 Agent（草稿工具）
  'set_trip_skeleton',
  'add_activity',
  'update_activity',
  'remove_activity',
  'get_draft',
  'move_activity',
  'set_lodging',
  'check_feasibility',
  'update_description',
  'update_titles',
  'submit_plan',
  // 其他 Agent 工具
  'geocode_place',
  'submit_review',
  'submit_trip_advice',
  // 系统任务（orchestrator.runSystemTask）
  'prefetch_verified_places',
  'geo_geocode_all',
  'optimize_day_routes',
  'geo_compute_legs',
  'simulate_feasibility',
  'schedule_itinerary',
  'repair_long_haul',
  'geo_geocode_review_changes',
  'geo_recompute_final_legs',
  'optimize_cross_day_grouping',
  'route_recompute_ordered_days',
  'prepare_trip_advice',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * 未知工具名（模型幻觉出的工具、新工具尚未配文案）统一落到这句泛化文案。
 * 永远不要退回服务端的中文 label —— 那是内部操作名。
 */
export const FALLBACK_TOOL_COPY = '继续梳理行程细节';

export const TOOL_COPY = {
  search_verified_places: '查找可靠的地点信息',
  search_pois: '寻找适合你的好去处',
  search_web: '参考当地游玩攻略',
  add_candidate: '收集心仪的好去处',
  submit_research: '整理旅行灵感',

  set_trip_skeleton: '安排每日行程',
  add_activity: '安排游玩活动',
  update_activity: '调整游玩安排',
  remove_activity: '精简行程安排',
  get_draft: '检查行程安排',
  move_activity: '调整游玩日期',
  set_lodging: '寻找方便落脚的区域',
  check_feasibility: '检查路线是否顺畅',
  update_description: '补充游玩提示',
  update_titles: '为旅程起个名字',
  submit_plan: '整理每日路线',

  geocode_place: '确认景点位置',
  submit_review: '整理旅行手账',
  submit_trip_advice: '补充出行小贴士',

  prefetch_verified_places: '筛选合适的地点',
  geo_geocode_all: '确认各个景点的位置',
  optimize_day_routes: '调整每天的游玩顺序',
  geo_compute_legs: '估算景点之间的路程',
  simulate_feasibility: '检查时间安排是否合理',
  schedule_itinerary: '排定每日行程表',
  repair_long_haul: '调整远郊行程安排',
  geo_geocode_review_changes: '确认最终景点位置',
  geo_recompute_final_legs: '检查景点之间的交通',
  optimize_cross_day_grouping: '优化每日游玩顺序',
  route_recompute_ordered_days: '复核调整后的路线',
  prepare_trip_advice: '准备出行提示',
} satisfies Record<ToolName, string>;

function isToolName(tool: string): tool is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(tool);
}

/** 工具名 → 用户向文案；未知工具名走 FALLBACK，不泄露内部 label。 */
export function toolCopy(tool: string): string {
  return isToolName(tool) ? TOOL_COPY[tool] : FALLBACK_TOOL_COPY;
}
