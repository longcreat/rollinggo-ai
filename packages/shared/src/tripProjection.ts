// 行程投影的领域形状：row = 一天，state = 行程/控制/任务图/用量/交互/可用性（键集合封闭）。
// 生成中与对话中共用同一形状 —— 「直播」与「对话」读的是同一份投影，不再各自从事件流合成。
import type { Activity, ResearchPoi, TransitLeg, Trip } from './types';
import type {
  ProjectionDelta,
  ProjectionFrame,
  ProjectionRowBase,
  ProjectionSnapshot,
} from './projection';

/** 阶段 / 工具进度节点（生成直播与任务面板共用）。 */
export interface ProjectionTaskNode {
  id: string;
  /** 阶段标识（research / plan / calibrate / write / gate / commit），对话条目可用 `chat`。 */
  phase: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  /** 阶段/步骤的用户可读结果摘要；卡片默认展示，详情里再展开步骤。 */
  summary?: string;
  startedAt?: number;
  durationMs?: number;
}

export interface ProjectionInteractionQuestion {
  id: string;
  question: string;
  options: { label: string }[];
  multiSelect?: boolean;
}

/** 待回答的问题卡 / 待决策的冲突卡。锚定在 transcript 上，刷新后由服务端投影恢复。 */
export interface ProjectionInteraction {
  id: string;
  kind: 'question' | 'tripDecision';
  questions: ProjectionInteractionQuestion[];
  createdAt: number;
  expiresAt?: number;
}

export interface ProjectionUsage {
  tokensIn: number;
  tokensOut: number;
  amapCalls: number;
  searchCalls: number;
}

export interface ProjectionControl {
  phase: string;
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  message?: string;
  /** 生成任务 id（job 或 durable task）；对话回合不设。 */
  jobId?: string;
  /** 落库后的正式行程 id；生成完成时出现。 */
  tripId?: string;
}

export interface TripProjectionRow extends ProjectionRowBase {
  kind: 'day';
  dayIndex: number;
  title: string;
  activities: Activity[];
  legs: TransitLeg[];
}

/** 行程头（轻量）：直播中不需要完整 Trip，天由 rows 承载。 */
export interface TripProjectionHeader {
  id: string;
  title: string;
  destination: string;
  startDate: string;
  /** 任务天数（job_start 回显；旧事件可能缺失）。 */
  days?: number;
  updatedAt: number;
  /** 调研候选（概览卡片）；完成后以落库行程为准。 */
  overview?: ResearchPoi[];
}

export interface TripProjectionState {
  /** 当前行程头（生成中为任务标题，完成后 id 换成落库 tripId）。 */
  trip: TripProjectionHeader | null;
  control: ProjectionControl;
  taskGraph: ProjectionTaskNode[];
  usage: ProjectionUsage | null;
  pendingInteractions: ProjectionInteraction[];
  availability: { canSend: boolean; reason?: string };
}

export function emptyTripProjectionState(): TripProjectionState {
  return {
    trip: null,
    control: { phase: 'idle', status: 'idle' },
    taskGraph: [],
    usage: null,
    pendingInteractions: [],
    availability: { canSend: true },
  };
}

export type TripProjectionSnapshot = ProjectionSnapshot<TripProjectionRow, TripProjectionState>;
export type TripProjectionDelta = ProjectionDelta<TripProjectionRow, TripProjectionState>;
export type TripProjectionFrame = ProjectionFrame<TripProjectionRow, TripProjectionState>;

/** 把行程的天转成投影行（rowId 从 1 递增，与 dayIndex 一一对应）。 */
export function rowsFromTrip(trip: Pick<Trip, 'days'>): TripProjectionRow[] {
  return trip.days.map((day, index) => ({
    rowId: index + 1,
    kind: 'day' as const,
    dayIndex: day.dayIndex,
    title: day.title,
    activities: day.activities,
    legs: day.legs ?? [],
  }));
}

/**
 * 投影 → 直播用的合成 Trip（只读）：编辑器与地图需要 Trip 形状，但真相在投影里。
 * 完成后页面会用落库的正式行程替换，这里的 id 只在直播期使用。
 */
export function tripFromProjection(snapshot: TripProjectionSnapshot): Trip | null {
  const header = snapshot.state.trip;
  if (!header) return null;
  return {
    id: header.id,
    title: header.title,
    destination: header.destination,
    startDate: header.startDate,
    budgetLevel: '舒适',
    totalBudget: 0,
    preferences: [],
    partySize: 2,
    extraNotes: '',
    transportMode: 'transit',
    days: snapshot.rows.window.map((row) => ({
      id: `proj-day-${row.rowId}`,
      dayIndex: row.dayIndex,
      title: row.title,
      activities: row.activities,
      ...(row.legs.length ? { legs: row.legs } : {}),
    })),
    ...(header.overview?.length ? { overview: header.overview } : {}),
    meta: { usedXhs: false, reviewNotes: [] },
    createdAt: 0,
    updatedAt: header.updatedAt,
  };
}