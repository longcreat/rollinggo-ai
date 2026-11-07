// 生成任务的前端生命周期：刷新恢复 / 任务接管 / 取消。
//
// 进度与终态来自统一投影（useGenerationProjection），本文件不再消费事件流；
// 事件环形缓冲与 /events 端点已删除。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { fetchJobSnapshot, keys, useCancelGeneration, useStartGeneration, type GenerationRequest } from '../api/hooks';
import { useGenerationProjection } from './useGenerationProjection';

export const ACTIVE_JOB_KEY = 'tw.activeJobId';

export interface GenerationRun {
  jobId: string | null;
  completed: { jobId: string; tripId: string } | null;
  /** 任务已到终态（done / error / cancelled）或已丢失。 */
  terminal: boolean;
  /** 首次挂载时正在查快照（决定重连 / 跳走 / 全新开始） */
  restoring: boolean;
  starting: boolean;
  /** 发起失败的可操作提示（配额 / 未配置 AI / 登录过期等） */
  errorMessage: string | null;
  destination: string;
  days: number;
  start: (form: GenerationRequest) => void;
  /** 接管已在跑的任务（服务端自动触发场景） */
  adopt: (jobId: string) => void;
  cancel: () => void;
  /** 结束当前任务视图，回到可重新发起的状态 */
  reset: () => void;
}

interface Options {
  enabled?: boolean;
  /** 生成成功后的落地动作（通常是跳转行程编辑器） */
  onDone: (tripId: string, jobId: string) => void;
  onStarted?: (jobId: string) => void;
}

function formatResetTime(resetAt: number): string {
  const d = new Date(resetAt);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function useGenerationRun({ onDone, onStarted, enabled = true }: Options): GenerationRun {
  const qc = useQueryClient();
  const startMutation = useStartGeneration();
  const cancel = useCancelGeneration();

  const [jobId, setJobId] = useState<string | null>(null);
  const [completed, setCompleted] = useState<GenerationRun['completed']>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(() => enabled && Boolean(sessionStorage.getItem(ACTIVE_JOB_KEY)));

  const activeJobIdRef = useRef<string | null>(null);
  /** onDone 每个任务只触发一次（投影可能多次下发同一终态）。 */
  const doneRef = useRef<string | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const onStartedRef = useRef(onStarted);
  onStartedRef.current = onStarted;

  const projection = useGenerationProjection(enabled ? jobId ?? undefined : undefined);
  const control = projection.snapshot?.state.control;
  const header = projection.snapshot?.state.trip;

  const resetCancel = cancel.reset;
  const clearJob = useCallback(() => {
    sessionStorage.removeItem(ACTIVE_JOB_KEY);
    activeJobIdRef.current = null;
    setJobId(null);
    setCompleted(null);
    setErrorMessage(null);
    resetCancel();
  }, [resetCancel]);

  // 刷新恢复：先查快照，再决定重连 / 跳走 / 什么也不做
  useEffect(() => {
    if (!enabled) return;
    const saved = sessionStorage.getItem(ACTIVE_JOB_KEY);
    if (!saved) return;
    let alive = true;
    fetchJobSnapshot(saved)
      .then((snap) => {
        if (!alive) return;
        if (snap.status === 'running') {
          activeJobIdRef.current = saved;
          setJobId(saved); // 投影会从这里重新拉快照
        } else if (snap.status === 'done' && snap.tripId) {
          sessionStorage.removeItem(ACTIVE_JOB_KEY);
          doneRef.current = saved;
          setCompleted({ jobId: saved, tripId: snap.tripId });
          onDoneRef.current(snap.tripId, saved);
        } else {
          sessionStorage.removeItem(ACTIVE_JOB_KEY);
        }
      })
      .catch((error) => {
        if (!alive) return;
        if (error instanceof ApiError && (error.status === 404 || error.status === 401)) sessionStorage.removeItem(ACTIVE_JOB_KEY);
        else setErrorMessage('暂时无法恢复生成进度，请检查网络后重试');
      })
      .finally(() => alive && setRestoring(false));
    return () => {
      alive = false;
    };
  }, [enabled]);

  // 终态来自投影：done 触发 onDone（一次），error/cancelled 只清会话与用量。
  const status = control?.status;
  const completedTripId = control?.tripId;
  useEffect(() => {
    if (!jobId || !status || status === 'idle' || status === 'running') return;
    sessionStorage.removeItem(ACTIVE_JOB_KEY);
    void qc.invalidateQueries({ queryKey: keys.usage });
    if (status === 'done' && completedTripId && doneRef.current !== jobId) {
      doneRef.current = jobId;
      void qc.invalidateQueries({ queryKey: keys.trips });
      setCompleted({ jobId, tripId: completedTripId });
      onDoneRef.current(completedTripId, jobId);
    }
  }, [jobId, status, completedTripId, qc]);

  // 任务已不在（服务重启 / 过期）：给明确错误，页面负责展示重试入口。
  useEffect(() => {
    if (!jobId || !projection.lost) return;
    sessionStorage.removeItem(ACTIVE_JOB_KEY);
    setErrorMessage('任务已丢失（服务可能重启过），本次不计入配额，请重新生成');
  }, [jobId, projection.lost]);

  const start = useCallback(
    (form: GenerationRequest) => {
      setErrorMessage(null);
      setCompleted(null);
      setJobId(null);
      startMutation.mutate(form, {
        onSuccess: ({ jobId: id }) => {
          resetCancel();
          sessionStorage.setItem(ACTIVE_JOB_KEY, id);
          activeJobIdRef.current = id;
          doneRef.current = null;
          setJobId(id);
          onStartedRef.current?.(id);
        },
        onError: (err) => {
          if (!(err instanceof ApiError)) {
            setErrorMessage('网络异常，请稍后重试');
            return;
          }
          if (err.status === 429) {
            const resetAt = typeof err.data?.resetAt === 'number' ? err.data.resetAt : null;
            setErrorMessage(`今日生成次数已用完${resetAt ? `，${formatResetTime(resetAt)} 后重置` : ''}。已有行程仍可继续编辑。`);
          } else if (err.status === 400 && err.code === 'no_llm') {
            setErrorMessage(
              err.data?.hasSiteKey
                ? '站点 AI 配置异常，请联系站长。'
                : '本站尚未配置 AI 服务，请联系站长开通后再试。',
            );
          } else if (err.status === 409 && typeof err.data?.jobId === 'string') {
            // 已有任务进行中 → 直接接管进度
            const id = err.data.jobId;
            resetCancel();
            sessionStorage.setItem(ACTIVE_JOB_KEY, id);
            activeJobIdRef.current = id;
            doneRef.current = null;
            setJobId(id);
          } else if (err.status === 401) {
            setErrorMessage('登录已过期，请刷新页面重新登录。');
          } else {
            setErrorMessage(err.message);
          }
        },
      });
    },
    [resetCancel, startMutation],
  );

  const cancelCurrent = useCallback(() => {
    if (!jobId || cancel.isPending) return;
    const cancelledJobId = jobId;
    cancel.mutate(cancelledJobId, {
      onSuccess: (snapshot) => {
        // mutation.reset() 只重置展示状态，不会中止已经发出的轮询；忽略旧任务的迟到回调
        if (snapshot.status !== 'cancelled' || activeJobIdRef.current !== cancelledJobId) return;
        sessionStorage.removeItem(ACTIVE_JOB_KEY);
        void qc.invalidateQueries({ queryKey: keys.usage });
      },
    });
  }, [cancel, jobId, qc]);

  /** 接管一个已在跑的任务（R3：服务端自动触发的生成，前端直接进进度视图） */
  const adopt = useCallback(
    (id: string) => {
      if (activeJobIdRef.current === id) return;
      resetCancel();
      setErrorMessage(null);
      setCompleted(null);
      sessionStorage.setItem(ACTIVE_JOB_KEY, id);
      activeJobIdRef.current = id;
      doneRef.current = null;
      setJobId(id);
    },
    [resetCancel],
  );

  return {
    jobId,
    completed,
    terminal: projection.lost || (status !== undefined && status !== 'idle' && status !== 'running'),
    restoring,
    starting: startMutation.isPending,
    errorMessage,
    destination: header?.destination ?? '',
    days: header?.days ?? 0,
    start,
    adopt,
    cancel: cancelCurrent,
    reset: clearJob,
  };
}
