// 生成事件 → 统一投影。
//
// 本适配器把 orchestrator / liveRun 的事件翻译成投影 delta；实时层只保留投影与订阅，
// 任务真相落在 generations 行。
// 关键点：行程的真相变成「行」——job_start 建空天，plan_day 逐日 upsert，客户端读到的就是真相，
// 不再依赖「重放事件重新合成」。
import {
  emptySnapshot,
  emptyTripProjectionState,
  getPlannerStageDisplay,
  type GenerationEvent,
  type ProjectionTaskNode,
  type TripProjectionDelta,
  type TripProjectionFrame,
  type TripProjectionRow,
  type TripProjectionState,
} from '@tripweaver/shared';
import { ProjectionChannel } from './projectionChannel';

const PHASE_LABEL: Record<string, string> = {
  exploration: '采风灵感',
  profiling: '甄选核验',
  climate: '顺应时候',
  routing: '慢游顺路',
  inspection: '自省推演',
  calibrate: '校准',
  write: '文案',
  gate: '验收',
  commit: '落库',
};

const MAX_DAYS = 15;

export interface GenerationProjection {
  channel: ProjectionChannel<TripProjectionRow, TripProjectionState>;
  /** 消费一条事件，返回本次产生的投影帧（供 SSE 下发）。 */
  consume(event: GenerationEvent): TripProjectionFrame[];
}

export function createGenerationProjection(jobId: string): GenerationProjection {
  const channel = new ProjectionChannel<TripProjectionRow, TripProjectionState>(
    emptySnapshot(emptyTripProjectionState()),
  );
  const tasks = new Map<string, ProjectionTaskNode>();
  let sink: TripProjectionFrame[] | null = null;

  const publish = (delta: TripProjectionDelta): TripProjectionFrame => {
    const frame = channel.publish(delta);
    sink?.push(frame);
    return frame;
  };
  const publishTasks = () => {
    publish({ op: 'state.updated', patch: { taskGraph: [...tasks.values()] } });
  };
  const setTask = (id: string, node: ProjectionTaskNode) => {
    tasks.set(id, node);
    publishTasks();
  };
  /** 终态收口：停止/失败后不能还有阶段或工具在转圈。 */
  const settleTasks = (status: 'done' | 'error') => {
    let changed = false;
    for (const [id, node] of tasks) {
      if (node.status !== 'running' && node.status !== 'pending') continue;
      tasks.set(id, { ...node, status });
      changed = true;
    }
    if (changed) publishTasks();
  };
  const phaseTaskId = (phase: string, round: number) => `phase:${phase}:${round}`;

  /** 天行按 dayIndex 一一对应：plan_day 早于 job_start 时先补齐占位行，保证行序单调。 */
  function ensureDayRow(dayIndex: number): void {
    const lastRowId = channel.snapshot.rows.window.at(-1)?.rowId ?? 0;
    for (let day = lastRowId + 1; day <= dayIndex; day += 1) {
      publish({
        op: 'row.appended',
        row: { rowId: day, kind: 'day', dayIndex: day, title: '', activities: [], legs: [] },
      });
    }
  }

  function handle(event: GenerationEvent): void {
    switch (event.type) {
      case 'job_start': {
        ensureDayRow(Math.max(1, Math.min(MAX_DAYS, event.days ?? 1)));
        publish({
          op: 'state.updated',
          patch: {
            trip: {
              id: jobId,
              title: `${event.destination} · 生成中`,
              destination: event.destination,
              startDate: event.startDate ?? '',
              ...(event.days !== undefined ? { days: event.days } : {}),
              updatedAt: 0,
            },
            control: { phase: 'idle', status: 'running', jobId },
          },
        });
        return;
      }
      case 'phase_start': {
        publish({ op: 'state.updated', patch: { control: { phase: event.phase, status: 'running', jobId } } });
        setTask(phaseTaskId(event.phase, event.round), {
          id: phaseTaskId(event.phase, event.round), phase: event.phase,
          label: PHASE_LABEL[event.phase] ?? event.phase, status: 'running',
          ...(event.at !== undefined ? { startedAt: event.at } : {}),
        });
        return;
      }
      case 'phase_end': {
        const id = phaseTaskId(event.phase, event.round);
        const node = tasks.get(id) ?? { id, phase: event.phase, label: PHASE_LABEL[event.phase] ?? event.phase, status: 'pending' as const };
        setTask(id, {
          ...node,
          status: 'done',
          ...(event.summary ? { summary: event.summary } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        });
        return;
      }
      case 'tool_start':
        setTask(event.toolCallId, {
          id: event.toolCallId, phase: event.phase, label: event.label, status: 'running',
          ...(event.at !== undefined ? { startedAt: event.at } : {}),
        });
        return;
      case 'tool_end': {
        const node = tasks.get(event.toolCallId) ?? {
          id: event.toolCallId, phase: event.phase, label: event.label, status: 'pending' as const,
        };
        setTask(event.toolCallId, {
          ...node, status: event.isError ? 'error' : 'done',
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        });
        return;
      }
      case 'plan_day': {
        ensureDayRow(event.dayIndex);
        const activities = event.stops.map((stop, index) => ({
          id: `live-${event.dayIndex}-${index}`,
          name: stop.name,
          startTime: stop.startTime,
          endTime: stop.endTime,
          description: '',
          lat: stop.lat,
          lng: stop.lng,
          coordSource: 'geocoded' as const,
          coordSystem: 'gcj02' as const,
          category: stop.category,
          sourceNotes: [],
        }));
        publish({
          op: 'row.upserted',
          row: { rowId: event.dayIndex, kind: 'day', dayIndex: event.dayIndex, title: event.title ?? '', activities, legs: [] },
        });
        return;
      }
      case 'candidate': {
        const trip = channel.snapshot.state.trip;
        if (!trip) return;
        publish({
          op: 'state.updated',
          patch: { trip: { ...trip, overview: [...(trip.overview ?? []), event.poi] } },
        });
        return;
      }
      case 'highlight': {
        const currentHighlights = channel.snapshot.state.highlights ?? [];
        const nextHighlight = {
          id: `hl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          stage: event.stage,
          text: event.text,
          kind: event.kind,
        };
        publish({
          op: 'state.updated',
          patch: {
            highlights: [...currentHighlights.slice(-5), nextHighlight],
          },
        });
        return;
      }
      case 'usage':
        publish({
          op: 'state.updated',
          patch: {
            usage: { tokensIn: event.tokensIn, tokensOut: event.tokensOut, amapCalls: event.amapCalls, searchCalls: event.searchCalls },
          },
        });
        return;
      case 'job_done': {
        settleTasks('done');
        const trip = channel.snapshot.state.trip;
        publish({
          op: 'state.updated',
          patch: {
            control: { phase: 'commit', status: 'done', jobId, tripId: event.tripId },
            ...(trip
              ? { trip: { ...trip, id: event.tripId, title: trip.title.replace(' · 生成中', ''), updatedAt: Date.now() } }
              : {}),
          },
        });
        return;
      }
      case 'job_error':
        settleTasks('error');
        publish({
          op: 'state.updated',
          patch: { control: { phase: 'idle', status: 'error', jobId, message: event.message } },
        });
        return;
      case 'job_cancelled':
        settleTasks('error');
        publish({
          op: 'state.updated',
          patch: { control: { phase: 'idle', status: 'cancelled', jobId, message: event.reason } },
        });
        return;
      // thought 已由阶段/工具进度表达；llm_response 只供评测，不进投影。
      default:
        return;
    }
  }

  function consume(event: GenerationEvent): TripProjectionFrame[] {
    const frames: TripProjectionFrame[] = [];
    sink = frames;
    try {
      handle(event);
    } finally {
      sink = null;
    }
    return frames;
  }

  return { channel, consume };
}