// 通知推送的订阅表（进程内）。
//
// 单实例边界（与 generation/jobManager 同一约定）：订阅表在内存里，多副本部署时
// B 副本写入的通知推不到 A 副本持有的连接上；那时要换 Postgres `pg_notify` + 专用
// LISTEN 连接，本期不做。
//
// 事件只是「有新东西」的提示，不是真相来源：客户端收到后必须回查
// GET /api/notifications 拿完整通知体。因此事件允许丢失（用户离线、进程重启），
// 不排队、不重放 —— 首屏查询负责补齐。
export interface NotificationEvent {
  kind: 'success' | 'error';
  title: string;
  tripId?: string | null;
}

type Listener = (event: NotificationEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function subscribeNotifications(userId: string, push: Listener): () => void {
  const set = listeners.get(userId) ?? new Set<Listener>();
  listeners.set(userId, set);
  set.add(push);
  return () => {
    set.delete(push);
    if (set.size === 0) listeners.delete(userId);
  };
}

/**
 * 写库成功之后调用。监听器抛错不能影响写入方（坏连接由 SSE 层的 close 清理），
 * 与 jobManager.emit 的「坏监听器绝不能拖垮流水线」是同一条约定。
 */
export function publishNotification(userId: string, event: NotificationEvent): void {
  for (const push of listeners.get(userId) ?? []) {
    try {
      push(event);
    } catch {
      /* 忽略：连接断开时 unsubscribe 会被 close 事件触发 */
    }
  }
}

/** 仅供诊断/测试：当前有连接的订阅用户数 */
export function notificationSubscriberCount(): number {
  return listeners.size;
}
