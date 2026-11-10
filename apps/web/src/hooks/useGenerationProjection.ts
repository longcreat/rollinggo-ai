// 生成直播的投影来源：REST 重订阅 + SSE 增量，遵守 zcode 三铁律。
//
// 关键：trip 的真相来自服务端投影（快照/行），不再由前端重放事件合成；
// 任务过期时 lost=true，页面必须给「重新生成」出口，不能停在「正在启动生成…」。
import { useEffect, useRef, useState } from 'react';
import {
  reduceProjectionMessage,
  type ProjectionMessage,
  type TripProjectionRow,
  type TripProjectionSnapshot,
  type TripProjectionState,
} from '@rollinggo-trip/shared';
import { api, ApiError } from '../api/client';
import { applyProjectionResume, type ProjectionResumeMessage } from '../lib/projectionResume';

export interface GenerationProjectionState {
  snapshot: TripProjectionSnapshot | null;
  /** 任务不存在 / 已过期：页面必须给显式重试入口。 */
  lost: boolean;
}

type Message = ProjectionMessage<TripProjectionRow, TripProjectionState>;
type ResumeMessage = ProjectionResumeMessage<TripProjectionRow, TripProjectionState>;

const RETRY_DELAYS_MS = [500, 1_500, 3_000] as const;
const TERMINAL = new Set(['done', 'error', 'cancelled']);

export function useGenerationProjection(jobId: string | undefined): GenerationProjectionState {
  const [snapshot, setSnapshot] = useState<TripProjectionSnapshot | null>(null);
  const [lost, setLost] = useState(false);
  const snapshotRef = useRef<TripProjectionSnapshot | null>(null);

  useEffect(() => {
    snapshotRef.current = null;
    setSnapshot(null);
    setLost(false);
    if (!jobId) return;

    let closed = false;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const update = (next: TripProjectionSnapshot | null) => {
      snapshotRef.current = next;
      setSnapshot(next);
    };
    const isTerminal = () => {
      const status = snapshotRef.current?.state.control.status;
      return status !== undefined && TERMINAL.has(status);
    };
    const closeSource = () => {
      source?.close();
      source = null;
    };

    /** 归约一条消息：applied / ignored / resync（调用方据此决定是否重订阅）。 */
    const applyMessage = (message: Message): 'applied' | 'ignored' | 'resync' => {
      const result = reduceProjectionMessage(snapshotRef.current, message);
      if (result.kind === 'ignored') return 'ignored';
      if (result.kind === 'resync') return 'resync';
      update(result.snapshot);
      return 'applied';
    };

    const connect = () => {
      if (closed) return;
      closeSource();
      const fromSeq = snapshotRef.current?.seq ?? 0;
      source = new EventSource(`/api/generations/${jobId}/projection/events?fromSeq=${fromSeq}`);
      source.onmessage = (event) => {
        let message: Message;
        try {
          message = JSON.parse(event.data) as Message;
        } catch {
          return; // 坏帧丢弃，等下一次重订阅
        }
        if (applyMessage(message) === 'resync') {
          void reload();
          return;
        }
        attempt = 0;
        if (isTerminal()) closeSource();
      };
      source.onerror = () => {
        closeSource();
        if (closed || isTerminal()) return;
        scheduleReload();
      };
    };

    /** REST 重订阅返回帧序列（可能为空）或整份快照，按序应用；任一帧断档都重订阅。 */
    const applyResume = (message: ResumeMessage): 'applied' | 'resync' => {
      const result = applyProjectionResume(snapshotRef.current, message);
      if (result.kind === 'resync') return 'resync';
      if (result.snapshot) update(result.snapshot);
      return 'applied';
    };

    /** REST 重订阅：由服务端裁决补帧还是重发快照；404/401 = 任务过期。 */
    const reload = async () => {
      try {
        const message = await api.get<ResumeMessage>(
          `/api/generations/${jobId}/projection?fromSeq=${snapshotRef.current?.seq ?? 0}`,
        );
        if (applyResume(message) === 'resync') {
          scheduleReload();
          return;
        }
        connect();
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 401)) {
          closed = true;
          closeSource();
          setLost(true);
          return;
        }
        scheduleReload();
      }
    };

    const scheduleReload = () => {
      if (closed) return;
      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!;
      attempt += 1;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => void reload(), delay);
    };

    void reload();
    return () => {
      closed = true;
      closeSource();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [jobId]);

  return { snapshot, lost };
}