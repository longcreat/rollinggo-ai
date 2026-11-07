// 旧生成事件流 → 统一投影（阶段二的过渡桥）。
//
// 现在由本适配器把 jobManager 的事件翻译成投影 delta；#7 把 orchestrator 迁到 defineTask 后，
// 改由 durable task 直接产出同样的 delta，本文件随旧事件流一起删除。
// 关键点：行程的真相变成「行」——job_start 建空天，plan_day 逐日 upsert，客户端读到的就是真相，
// 不再依赖「重放 512 条事件重新合成」。
import {
  emptySnapshot,
  emptyTripProjectionState,
  type GenerationEvent,
  type ProjectionTaskNode,
  type TripProjectionRow,
  type TripProjectionState,
} from '@tripweaver/shared';
import { ProjectionChannel } from './projectionChannel';

const PHASE_LABEL: Record<string, string> = {
  research: '调研', plan: '规划', review: '审校', calibrate: '校准', write: '文案', gate: '验收', commit: '落库',
};

const MAX_DAYS = 15;

export interface GenerationProjection {
  channel: ProjectionChannel<TripProjectionRow, TripProjectionState>;
  consume(event: GenerationEvent): void;
}

export function createGenerationProjection(jobId: string): GenerationProjection {
  const channel = new ProjectionChannel<TripProjectionRow, TripProjectionState>(
    emptySnapshot(emptyTripProjectionState()),
  );
  const tasks = new Map<string, ProjectionTaskNode>();

  const publishTasks = () => {
    channel.publish({ op: 'state.updated', patch: { taskGraph: [...tasks.values()] } });
  };
  const setTask = (id: string, node: ProjectionTaskNode) => {
    tasks.set(id, node);
    publishTasks();
  };
  const phaseTaskId = (phase: string, round: number) => `phase:${phase}:${round}`;

  /** 天行按 dayIndex 一一对应：plan_day 早于 job_start 时先补齐占位行，保证行序单调。 */
  function ensureDayRow(dayIndex: number): TripProjectionRow | undefined {
    let current = channel.snapshot.rows.window.find((row) => row.rowId === dayIndex);
    const lastRowId = channel.snapshot.rows.window.at(-1)?.rowId ?? 0;
    for (let day = lastRowId + 1; day <= dayIndex; day += 1) {
      channel.publish({
        op: 'row.appended',
        row: { rowId: day, kind: 'day', dayIndex: day, title: '', activities: [], legs: [] },
      });
    }
    current = channel.snapshot.rows.window.find((row) => row.rowId === dayIndex);
    return current;
  }

  function consume(event: GenerationEvent): void {
    switch (event.type) {
      case 'job_start': {
        const days = Math.max(1, Math.min(MAX_DAYS, event.days ?? 1));
        ensureDayRow(days);
        channel.publish({
          op: 'state.updated',
          patch: {
            trip: {
              id: jobId,
              title: `${event.destination} · 生成中`,
              destination: event.destination,
              startDate: event.startDate ?? '',
              updatedAt: 0,
            },
            control: { phase: 'idle', status: 'running', jobId },
          },
        });
        return;
      }
      case 'phase_start': {
        channel.publish({ op: 'state.updated', patch: { control: { phase: event.phase, status: 'running', jobId } } });
        setTask(phaseTaskId(event.phase, event.round), {
          id: phaseTaskId(event.phase, event.round), phase: event.phase,
          label: PHASE_LABEL[event.phase] ?? event.phase, status: 'running',
        });
        return;
      }
      case 'phase_end': {
        const id = phaseTaskId(event.phase, event.round);
        const node = tasks.get(id) ?? { id, phase: event.phase, label: PHASE_LABEL[event.phase] ?? event.phase, status: 'pending' as const };
        setTask(id, { ...node, status: 'done', ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}) });
        return;
      }
      case 'tool_start':
        setTask(event.toolCallId, {
          id: event.toolCallId, phase: event.phase, label: event.label, status: 'running',
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
        channel.publish({
          op: 'row.upserted',
          row: { rowId: event.dayIndex, kind: 'day', dayIndex: event.dayIndex, title: event.title ?? '', activities, legs: [] },
        });
        return;
      }
      case 'candidate': {
        const trip = channel.snapshot.state.trip;
        if (!trip) return;
        channel.publish({
          op: 'state.updated',
          patch: { trip: { ...trip, overview: [...(trip.overview ?? []), event.poi] } },
        });
        return;
      }
      case 'usage':
        channel.publish({
          op: 'state.updated',
          patch: {
            usage: { tokensIn: event.tokensIn, tokensOut: event.tokensOut, amapCalls: event.amapCalls, searchCalls: event.searchCalls },
          },
        });
        return;
      case 'job_done': {
        const trip = channel.snapshot.state.trip;
        channel.publish({
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
        channel.publish({
          op: 'state.updated',
          patch: { control: { phase: 'idle', status: 'error', jobId, message: event.message } },
        });
        return;
      case 'job_cancelled':
        channel.publish({
          op: 'state.updated',
          patch: { control: { phase: 'idle', status: 'cancelled', jobId, message: event.reason } },
        });
        return;
      // thought 已由阶段/工具进度表达；llm_response 只供评测，不进投影。
      default:
        return;
    }
  }

  return { channel, consume };
}