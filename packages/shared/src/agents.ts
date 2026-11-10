// TripAgent（主管家）与 TripPlannerAgent（规划子代理）规范与阶段 UI 语义
// 对齐 TeamAgent / Subagent 协同架构，面向用户提供富含旅行温度与仪式感的文案。

export type AgentRole = 'coordinator' | 'subagent';

export interface AgentDescriptor {
  readonly id: string;
  readonly name: string;
  readonly role: AgentRole;
  readonly description: string;
}

export const TRIP_AGENT: AgentDescriptor = {
  id: 'trip_agent',
  name: 'TripAgent',
  role: 'coordinator',
  description: 'AI 旅行主管家：负责需求沟通、偏好探索、人机交互与轻量微调',
};

export const TRIP_PLANNER_AGENT: AgentDescriptor = {
  id: 'trip_planner_agent',
  name: 'TripPlannerAgent',
  role: 'subagent',
  description: '旅行规划专家子代理：负责 0 到 1 深度行程规划、避雷画像、顺路排程与自检审查',
};

/** 规划子代理的 5 个精细化工作阶段 */
export const PLANNER_STAGE_KEYS = [
  'exploration', // 阶段 1：攻略挖掘
  'profiling',   // 阶段 2：点位画像与避雷
  'climate',     // 阶段 3：天气与日历感知
  'routing',     // 阶段 4：顺路动线与地道吃喝
  'inspection',  // 阶段 5：规划师自省审查
] as const;

export type PlannerStageKey = (typeof PLANNER_STAGE_KEYS)[number];

export interface PlannerStageMetadata {
  readonly key: PlannerStageKey;
  readonly internalName: string;
  /** 面向用户的优雅主标题（富有旅行仪式感） */
  readonly clientTitle: string;
  /** 副标题：清晰交代该阶段带来的用户价值 */
  readonly clientSubtitle: string;
  /** 运行中的动态短句（用于卡片雷达下方的流动展示） */
  readonly runningHighlight: string;
  /** 阶段图标代号（供前端映射） */
  readonly iconType: 'compass' | 'shield' | 'cloud-sun' | 'route' | 'sparkles';
}

export const PLANNER_STAGES: Record<PlannerStageKey, PlannerStageMetadata> = {
  exploration: {
    key: 'exploration',
    internalName: '查找热门旅游攻略',
    clientTitle: '采风灵感 · 翻阅当季宝藏路线',
    clientSubtitle: '深入挖掘目的地当季风物、小众秘境与经典游法',
    runningHighlight: '正在翻阅全网旅行家攻略，汲取精华游玩灵感…',
    iconType: 'compass',
  },
  profiling: {
    key: 'profiling',
    internalName: '检索点位评价与避雷',
    clientTitle: '甄选核验 · 探访真实口碑避坑',
    clientSubtitle: '打磨必去清单，洞悉真实排队与游玩避雷要点',
    runningHighlight: '正在核实景点真实口碑、避坑指南与最佳入园时刻…',
    iconType: 'shield',
  },
  climate: {
    key: 'climate',
    internalName: '感知天气与开放日历',
    clientTitle: '顺应时候 · 校准天候与展馆开放',
    clientSubtitle: '对齐当地天气预测与场馆开放档期，杜绝跑空遗憾',
    runningHighlight: '正在校准出行天气预报与景区展馆开闭馆时间表…',
    iconType: 'cloud-sun',
  },
  routing: {
    key: 'routing',
    internalName: '计算顺路路线与吃喝',
    clientTitle: '慢游顺路 · 编排不折返动线与美食',
    clientSubtitle: '按几何顺路算法串联每日动线，就近甄选地道老饕餐厅',
    runningHighlight: '正在优化顺路动线，计算步行通勤与就近特色餐次…',
    iconType: 'route',
  },
  inspection: {
    key: 'inspection',
    internalName: '资深规划师自检审查',
    clientTitle: '自省推演 · 全盘模拟节奏舒缓不赶路',
    clientSubtitle: '反复推演行程体力负荷与通勤时间，确保体验充实舒适',
    runningHighlight: '规划师正在全盘自检行程合理性，精修游玩节奏…',
    iconType: 'sparkles',
  },
};

export function getPlannerStageDisplay(key: string): PlannerStageMetadata {
  if (key in PLANNER_STAGES) {
    return PLANNER_STAGES[key as PlannerStageKey];
  }
  return {
    key: 'exploration',
    internalName: key,
    clientTitle: key,
    clientSubtitle: '智能规划助手正在精心定制中',
    runningHighlight: '正在处理行程细节…',
    iconType: 'compass',
  };
}

/** 实时亮点反馈事件（在卡片中滚动展示惊喜细节） */
export interface PlannerHighlightTicker {
  readonly id: string;
  readonly stage: PlannerStageKey | string;
  readonly title?: string;
  readonly text: string;
  readonly kind?: 'poi' | 'tip' | 'route' | 'food';
}
