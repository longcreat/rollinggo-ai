// 直播播报模型：直接读服务端投影的 taskGraph，不再归约事件流。
//
// 子 Agent 以阶段为单位呈现：每张卡片只给状态/步数/结果摘要，完整工具流程留在 lines 里，
// 由页面在用户点击卡片时展开。这样默认界面是结论，而不是内部工作流。
import type { DataSourceKind, ProjectionTaskNode, ResearchPoi, TripProjectionSnapshot, TripProjectionState } from '@rollinggo-trip/shared';

export interface LiveLine {
  id: string;
  kind: 'thought' | 'tool';
  text: string;
  running: boolean;
  error: boolean;
  durationMs?: number;
}

export type LivePhaseStatus = 'pending' | 'running' | 'done' | 'error';

export interface LivePhase {
  key: string;
  label: string;
  status: LivePhaseStatus;
  done: boolean;
  running: boolean;
  error: boolean;
  /** 已完成的工具步数 / 总工具步数（卡片进度条）。 */
  completed: number;
  total: number;
  /** 阶段结束后服务端给的结果摘要，卡片默认展示。 */
  summary?: string;
  /** 运行中的当前动作，卡片用它替代摘要。 */
  current?: string;
  durationMs?: number;
  /** 该阶段的完整工具流程，只给详情层使用。 */
  lines: LiveLine[];
}

export type LiveTerminal =
  | { type: 'job_done'; tripId: string; usedXhs: boolean; dataSources: DataSourceKind[]; reviewNotes: string[] }
  | { type: 'job_error'; message: string }
  | { type: 'job_cancelled'; reason?: 'user' | 'timeout' };

export interface LiveStream {
  phases: LivePhase[];
  candidates: ResearchPoi[];
  /** 最近一条进行中的动作，用于顶部一句话状态 */
  active: LiveLine | null;
  terminal: LiveTerminal | null;
}

const PHASE_LABEL: Record<string, string> = {
  exploration: '采风灵感 · 翻阅当季宝藏路线',
  profiling: '甄选核验 · 探访真实口碑避坑',
  climate: '顺应时候 · 校准天候与展馆开放',
  routing: '慢游顺路 · 编排不折返动线与美食',
  inspection: '自省推演 · 全盘模拟节奏舒缓不赶路',
  calibrate: '校准通勤与餐次',
  write: '整理文案与建议',
  gate: '行前校验',
  commit: '保存行程',
};

const MAX_DETAIL_LINES = 200;

function terminalFromControl(control: TripProjectionState['control']): LiveTerminal | null {
  if (control.status === 'done') {
    return { type: 'job_done', tripId: control.tripId ?? '', usedXhs: false, dataSources: [], reviewNotes: [] };
  }
  if (control.status === 'error') return { type: 'job_error', message: control.message ?? '生成失败' };
  if (control.status === 'cancelled') {
    return { type: 'job_cancelled', reason: control.message === 'timeout' ? 'timeout' : 'user' };
  }
  return null;
}

function lineOf(node: ProjectionTaskNode): LiveLine {
  return {
    id: node.id,
    kind: 'tool',
    text: node.status === 'running' ? `正在${node.label}…` : node.status === 'error' ? `${node.label}未完成` : `${node.label}完成`,
    running: node.status === 'running',
    error: node.status === 'error',
    ...(node.durationMs !== undefined ? { durationMs: node.durationMs } : {}),
  };
}

/** 投影 → 播报模型：阶段卡片 + 各自完整工具流程。 */
export function buildLiveStreamFromProjection(
  snapshot: TripProjectionSnapshot,
  maxCandidates = 12,
): LiveStream {
  const groups = new Map<string, { phases: ProjectionTaskNode[]; tools: ProjectionTaskNode[] }>();
  for (const node of snapshot.state.taskGraph) {
    const group = groups.get(node.phase) ?? { phases: [], tools: [] };
    if (node.id.startsWith('phase:')) group.phases.push(node);
    else group.tools.push(node);
    groups.set(node.phase, group);
  }

  const phases: LivePhase[] = [...groups.entries()].map(([phase, group]) => {
    const lastPhase = group.phases.at(-1);
    const anyRunning = group.phases.some((node) => node.status === 'running')
      || group.tools.some((node) => node.status === 'running');
    const anyError = group.phases.some((node) => node.status === 'error')
      || group.tools.some((node) => node.status === 'error');
    const status: LivePhaseStatus = anyError
      ? 'error'
      : anyRunning
        ? 'running'
        : lastPhase?.status === 'done' || (group.tools.length > 0 && group.tools.every((node) => node.status === 'done'))
          ? 'done'
          : 'pending';
    const completed = group.tools.filter((node) => node.status === 'done').length;
    const runningLine = group.tools.find((node) => node.status === 'running');
    return {
      key: phase,
      label: PHASE_LABEL[phase] ?? lastPhase?.label ?? phase,
      status,
      done: status === 'done',
      running: status === 'running',
      error: status === 'error',
      completed,
      total: group.tools.length,
      ...(lastPhase?.summary ? { summary: lastPhase.summary } : {}),
      ...(runningLine ? { current: `正在${runningLine.label}…` } : {}),
      ...(lastPhase?.durationMs !== undefined ? { durationMs: lastPhase.durationMs } : {}),
      lines: group.tools.slice(-MAX_DETAIL_LINES).map(lineOf),
    };
  });

  const active = phases.flatMap((phase) => phase.lines).filter((line) => line.running).at(-1) ?? null;
  return {
    phases,
    candidates: (snapshot.state.trip?.overview ?? []).slice(-maxCandidates),
    active,
    terminal: terminalFromControl(snapshot.state.control),
  };
}
