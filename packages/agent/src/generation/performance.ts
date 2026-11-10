import type { GenerationPhase, GenerationJobStatus } from '@tripweaver/shared';

interface TaskStart {
  at: number;
  key: string;
}

interface TaskAggregate {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface TimingEnd {
  at: number;
  durationMs?: number;
}

export interface GenerationTimingSummary {
  status: GenerationJobStatus;
  totalMs: number;
  phases: Record<string, number>;
  tasks: Record<string, TaskAggregate>;
  activePhases: Record<string, number>;
  activeTasks: Record<string, number>;
}

const phaseKey = (phase: GenerationPhase, round: number) => `${phase}:${round}`;

/** 并发阶段/请求按区间并集计算墙钟，不能直接相加。 */
export function unionDurationMs(spans: readonly { start: number; end: number }[]): number {
  const sorted = spans.filter((span) => span.end >= span.start).sort((a, b) => a.start - b.start);
  if (!sorted.length) return 0;
  let start = sorted[0]!.start;
  let end = sorted[0]!.end;
  let total = 0;
  for (const span of sorted.slice(1)) {
    if (span.start <= end) end = Math.max(end, span.end);
    else { total += end - start; start = span.start; end = span.end; }
  }
  return total + end - start;
}

/** 单任务内存计时器。只保存稳定名称和毫秒数，不接触 prompt、参数或用户输入。 */
export class GenerationPerformance {
  private readonly phaseStarts = new Map<string, number>();
  private readonly phaseDurations = new Map<string, number>();
  private readonly taskStarts = new Map<string, TaskStart>();
  private readonly taskAggregates = new Map<string, TaskAggregate>();

  constructor(
    private readonly startedAt: number,
    private readonly now: () => number = Date.now,
  ) {}

  startPhase(phase: GenerationPhase, round: number): number {
    const at = this.now();
    this.phaseStarts.set(phaseKey(phase, round), at);
    return at;
  }

  endPhase(phase: GenerationPhase, round: number): TimingEnd {
    const at = this.now();
    const key = phaseKey(phase, round);
    const startedAt = this.phaseStarts.get(key);
    this.phaseStarts.delete(key);
    if (startedAt === undefined) return { at };
    const durationMs = Math.max(0, at - startedAt);
    this.phaseDurations.set(key, durationMs);
    return { at, durationMs };
  }

  startTask(id: string, key: string): number {
    const at = this.now();
    this.taskStarts.set(id, { at, key });
    return at;
  }

  endTask(id: string): TimingEnd {
    const at = this.now();
    const started = this.taskStarts.get(id);
    this.taskStarts.delete(id);
    if (!started) return { at };
    const durationMs = Math.max(0, at - started.at);
    const current = this.taskAggregates.get(started.key) ?? { count: 0, totalMs: 0, maxMs: 0 };
    current.count += 1;
    current.totalMs += durationMs;
    current.maxMs = Math.max(current.maxMs, durationMs);
    this.taskAggregates.set(started.key, current);
    return { at, durationMs };
  }

  summary(status: GenerationJobStatus): GenerationTimingSummary {
    const at = this.now();
    const activeTasks: Record<string, number> = {};
    for (const task of this.taskStarts.values()) {
      activeTasks[task.key] = (activeTasks[task.key] ?? 0) + Math.max(0, at - task.at);
    }
    return {
      status,
      totalMs: Math.max(0, at - this.startedAt),
      phases: Object.fromEntries(this.phaseDurations),
      tasks: Object.fromEntries([...this.taskAggregates].map(([key, value]) => [key, { ...value }])),
      activePhases: Object.fromEntries([...this.phaseStarts].map(([key, startedAt]) => [key, Math.max(0, at - startedAt)])),
      activeTasks,
    };
  }
}
