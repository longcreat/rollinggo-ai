import type { DataSourceKind, GenerationEvent, GenerationPhase, ResearchPoi } from '@tripweaver/shared';

export interface ToolItem {
  kind: 'tool';
  key: string;
  /** 稳定工具名（tool_start.tool）：文案映射只认它，label 会随服务端改文案而变，不进前端模型 */
  tool: string;
  summary: string;
  isError: boolean;
  running: boolean;
  startedAt?: number;
  durationMs?: number;
}

export interface ThoughtItem {
  kind: 'thought';
  key: string;
  text: string;
}

export type TimelineItem = ToolItem | ThoughtItem;

export interface PhaseBlock {
  key: string;
  phase: GenerationPhase;
  round: number;
  note?: string;
  done: boolean;
  items: TimelineItem[];
  startedAt?: number;
  durationMs?: number;
}

export interface TimelineModel {
  dataSources: DataSourceKind[] | null;
  /** job_start 带回的任务参数：刷新/恢复链路里 URL 没有日期，标题只能靠它（见 09-27 视觉对齐任务） */
  destination?: string;
  days?: number;
  candidates: ResearchPoi[];
  phases: PhaseBlock[];
  usage: { tokensIn: number; tokensOut: number; amapCalls: number; searchCalls: number } | null;
  terminal: Extract<GenerationEvent, { type: 'job_done' | 'job_error' | 'job_cancelled' }> | null;
  startedAt?: number;
  durationMs?: number;
}

function eventDuration(explicit: number | undefined, startedAt: number | undefined, endedAt: number | undefined): number | undefined {
  if (explicit !== undefined) return Math.max(0, explicit);
  if (startedAt === undefined || endedAt === undefined) return undefined;
  return Math.max(0, endedAt - startedAt);
}

/** 从事件流重建时间线；只依赖服务端事件，刷新重放可得到相同的已完成耗时。 */
export function buildTimeline(events: GenerationEvent[]): TimelineModel {
  const model: TimelineModel = { dataSources: null, candidates: [], phases: [], usage: null, terminal: null };
  let seq = 0;
  for (const ev of events) {
    seq += 1;
    switch (ev.type) {
      case 'job_start':
        model.dataSources = ev.dataSources;
        model.destination = ev.destination;
        model.days = ev.days;
        model.startedAt = ev.at;
        break;
      case 'phase_start':
        model.phases.push({
          key: `${ev.phase}-${ev.round}`,
          phase: ev.phase,
          round: ev.round,
          note: ev.note,
          done: false,
          items: [],
          startedAt: ev.at,
        });
        break;
      case 'phase_end': {
        const block = model.phases.find((phase) => phase.phase === ev.phase && phase.round === ev.round);
        if (block) {
          block.done = true;
          block.durationMs = eventDuration(ev.durationMs, block.startedAt, ev.at);
        }
        break;
      }
      case 'thought': {
        // 按 ev.phase 找未完成块：文案与 plan 阶段并发后，phases.at(-1) 会把地理进度归到文案块
        // （文案块后创建）。与 tool_start 同一匹配规则，并发下不再错位。
        const block = model.phases.find((phase) => phase.phase === ev.phase && !phase.done) ?? model.phases.at(-1);
        block?.items.push({ kind: 'thought', key: `t${seq}`, text: ev.text });
        break;
      }
      case 'tool_start': {
        const block = model.phases.find((phase) => phase.phase === ev.phase && !phase.done) ?? model.phases.at(-1);
        block?.items.push({
          kind: 'tool',
          key: ev.toolCallId,
          tool: ev.tool,
          summary: '',
          isError: false,
          running: true,
          startedAt: ev.at,
        });
        break;
      }
      case 'tool_end': {
        for (const phase of model.phases) {
          const item = phase.items.find((candidate): candidate is ToolItem => candidate.kind === 'tool' && candidate.key === ev.toolCallId);
          if (item) {
            item.summary = ev.summary;
            item.isError = ev.isError;
            item.running = false;
            item.durationMs = eventDuration(ev.durationMs, item.startedAt, ev.at);
            break;
          }
        }
        break;
      }
      case 'candidate':
        model.candidates.push(ev.poi);
        break;
      case 'usage':
        model.usage = { tokensIn: ev.tokensIn, tokensOut: ev.tokensOut, amapCalls: ev.amapCalls, searchCalls: ev.searchCalls };
        break;
      case 'job_done':
      case 'job_error':
      case 'job_cancelled':
        model.terminal = ev;
        model.durationMs = eventDuration(ev.durationMs, model.startedAt, ev.at);
        break;
    }
  }
  return model;
}

export function formatDuration(durationMs: number): string {
  const safeMs = Math.max(0, durationMs);
  if (safeMs === 0) return '0 秒';
  if (safeMs < 60_000) {
    const seconds = Math.round(safeMs / 100) / 10;
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  }
  const totalSeconds = Math.round(safeMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

