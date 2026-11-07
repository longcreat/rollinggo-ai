// 直播页的数据入口：接管指定 job 的 SSE，同时产出合成行程与播报模型。
import { useEffect, useMemo } from 'react';
import { tripFromProjection, type Trip } from '@tripweaver/shared';
import { useGenerationRun } from './useGenerationRun';
import { useGenerationProjection } from './useGenerationProjection';
import { buildTimeline } from '../lib/generationTimeline';
import { buildLiveStream, type LiveStream } from '../lib/liveAgentStream';

export interface LiveTripState {
  trip: Trip | null;
  stream: LiveStream;
  events: ReturnType<typeof useGenerationRun>['events'];
  completedTripId: string | null;
  cancelling: boolean;
  cancellationError: string | null;
  error: string | null;
  /** 任务已不在（服务重启/过期）：显示重新生成入口 */
  lost: boolean;
  cancel: () => void;
}

export function useLiveTrip(jobId: string | undefined): LiveTripState {
  const enabled = Boolean(jobId);
  // 完成动作由页面处理（原地切到正式行程），这里不导航。
  const run = useGenerationRun({ onDone: () => {}, enabled });
  const { adopt } = run;

  useEffect(() => {
    if (jobId) adopt(jobId);
  }, [adopt, jobId]);

  const model = useMemo(() => buildTimeline(run.events), [run.events]);
  // 行程的真相来自服务端投影（行/快照），不再由前端重放事件合成。
  const projection = useGenerationProjection(enabled ? jobId : undefined);
  const trip = useMemo(
    () => (projection.snapshot ? tripFromProjection(projection.snapshot) : null),
    [projection.snapshot],
  );
  const stream = useMemo(() => buildLiveStream(model), [model]);
  const terminal = run.events.find((event) => event.type === 'job_error' || event.type === 'job_cancelled');
  const lost = projection.lost || (terminal?.type === 'job_error' && terminal.message.includes('任务已丢失'));

  return {
    trip,
    stream,
    events: run.events,
    completedTripId: run.completed?.tripId ?? null,
    cancelling: run.cancelPending,
    cancellationError: run.cancellationError,
    error: run.errorMessage ?? (terminal?.type === 'job_error' ? terminal.message : null),
    lost,
    cancel: run.cancel,
  };
}
