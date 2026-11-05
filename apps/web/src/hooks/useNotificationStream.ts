import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { keys } from '../api/hooks';

/**
 * 通知的实时通道（SSE）。
 *
 * 服务端在写库成功后推一条「有新通知」的提示，这里收到后只做 invalidate，
 * 完整通知体仍由 GET /api/notifications 取 —— DB 是单一真相源，事件允许丢失。
 *
 * - EventSource 断线自带重连，页面切回也会自己接上；服务端重启期间收不到提示，
 *   靠 useNotifications 的轮询兜底
 * - 只订阅 `notification` 事件，heartbeat 注释行由浏览器自行忽略
 */
export function useNotificationStream(userId: string): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!userId) return;
    const es = new EventSource('/api/notifications/stream');
    const onNotification = (event: MessageEvent<string>) => {
      void qc.invalidateQueries({ queryKey: keys.notifications(userId) });
      // 生成成功同时让「我的行程」列表与那一份行程失效：用户可能正停在列表页等结果。
      // 失败/取消不改行程，不必重拉列表。
      try {
        const data = JSON.parse(event.data) as { kind?: string; tripId?: string | null };
        if (data.kind === 'success') void qc.invalidateQueries({ queryKey: keys.trips });
        if (data.tripId) void qc.invalidateQueries({ queryKey: keys.trip(data.tripId) });
      } catch {
        /* 事件体不合法时只当普通提示处理 */
      }
    };
    es.addEventListener('notification', onNotification);
    return () => {
      es.removeEventListener('notification', onNotification);
      es.close();
    };
  }, [userId, qc]);
}
