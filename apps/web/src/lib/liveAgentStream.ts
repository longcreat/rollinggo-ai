// 直播播报模型：直接读服务端投影的 taskGraph，不再归约事件流。
//
// 旧版（buildTimeline + buildLiveStream）随事件归约一起删除：阶段/工具进度已由
// projectionAdapter 写进 state.taskGraph，文案使用服务端下发的 label。
import type { DataSourceKind, ProjectionTaskNode, ResearchPoi, TripProjectionSnapshot, TripProjectionState } from '@tripweaver/shared';

export interface LiveLine {
  id: string;
  kind: 'thought' | 'tool';
  text: string;
  running: boolean;
  error: boolean;
}

export interface LivePhase {
  key: string;
  label: string;
  done: boolean;
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
  research: '查找地点与资料',
  plan: '规划每日行程',
  review: '整理文案与建议',
  calibrate: '校准通勤与餐次',
  write: '整理文案与建议',
  gate: '行前校验',
  commit: '保存行程',
};

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

/** 投影 → 播报模型：阶段与工具进度来自 state.taskGraph，候选来自行程头。 */
export function buildLiveStreamFromProjection(
  snapshot: TripProjectionSnapshot,
  maxLinesPerPhase = 8,
  maxCandidates = 12,
): LiveStream {
  const groups = new Map<string, ProjectionTaskNode[]>();
  for (const node of snapshot.state.taskGraph) {
    const list = groups.get(node.phase) ?? [];
    list.push(node);
    groups.set(node.phase, list);
  }
  const phases: LivePhase[] = [...groups.entries()].map(([phase, nodes]) => ({
    key: phase,
    label: PHASE_LABEL[phase] ?? phase,
    done: nodes.every((node) => node.status === 'done' || node.status === 'error'),
    lines: nodes.slice(-maxLinesPerPhase).map((node) => ({
      id: node.id,
      kind: 'tool' as const,
      text: node.status === 'running' ? `正在${node.label}…` : node.status === 'error' ? `${node.label}未完成` : `${node.label}完成`,
      running: node.status === 'running',
      error: node.status === 'error',
    })),
  }));
  const active = phases.flatMap((phase) => phase.lines).filter((line) => line.running).at(-1) ?? null;
  return {
    phases,
    candidates: (snapshot.state.trip?.overview ?? []).slice(-maxCandidates),
    active,
    terminal: terminalFromControl(snapshot.state.control),
  };
}