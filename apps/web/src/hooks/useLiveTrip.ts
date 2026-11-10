// 直播页的数据入口：只连一条统一投影 SSE。
//
// 行程、播报、终态全部来自服务端投影（快照/行），不再由前端重放事件合成，
// 也不再额外开第二条事件 SSE —— 任务生命周期由持久任务行与投影共同表达。
import { useMemo } from 'react';
import { tripFromProjection, type Trip } from '@rollinggo-trip/shared';
import { useGenerationProjection } from './useGenerationProjection';
import { useCancelGeneration } from '../api/hooks';
import { buildLiveStreamFromProjection, type LiveStream } from '../lib/liveAgentStream';

const EMPTY_STREAM: LiveStream = { phases: [], candidates: [], active: null, terminal: null };

export interface LiveTripState {
  trip: Trip | null;
  stream: LiveStream;
  completedTripId: string | null;
  cancelling: boolean;
  cancellationError: string | null;
  error: string | null;
  /** 任务已不在（服务重启/过期）：显示重新生成入口 */
  lost: boolean;
  cancel: () => void;
}

export function useLiveTrip(jobId: string | undefined): LiveTripState {
  const projection = useGenerationProjection(jobId);
  const cancelMutation = useCancelGeneration();

  const trip = useMemo(
    () => (projection.snapshot ? tripFromProjection(projection.snapshot) : null),
    [projection.snapshot],
  );
  const stream = useMemo(
    () => (projection.snapshot ? buildLiveStreamFromProjection(projection.snapshot) : EMPTY_STREAM),
    [projection.snapshot],
  );
  const control = projection.snapshot?.state.control;

  return {
    trip,
    stream,
    completedTripId: control?.status === 'done' ? control.tripId ?? null : null,
    cancelling: cancelMutation.isPending,
    cancellationError: cancelMutation.error instanceof Error ? cancelMutation.error.message : null,
    error: control?.status === 'error' ? control.message ?? '生成失败' : null,
    lost: projection.lost,
    cancel: () => {
      if (jobId) cancelMutation.mutate(jobId);
    },
  };
}