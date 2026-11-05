import { and, desc, eq, isNull, lt, lte } from 'drizzle-orm';
import { uid, type GenerationJobView, type GenerationNotification, type NotificationPage, type Trip, type TripShareImageStyle } from '@tripweaver/shared';
import { db } from '../db/client';
import { generationNotifications as notifications } from '../db/schema';
import { publishNotification, type NotificationEvent } from './notificationStream';

type NewNotification = Omit<typeof notifications.$inferInsert, 'id' | 'sequence' | 'createdAt' | 'readAt'>;
function notificationView(row: typeof notifications.$inferSelect): GenerationNotification {
  return {
    id: row.id, sequence: row.sequence, jobId: row.jobId, kind: row.kind, tripId: row.tripId,
    title: row.title, message: row.message, createdAt: row.createdAt.getTime(), readAt: row.readAt?.getTime() ?? null,
    ...(row.shareImageStyle ? { shareImageStyle: row.shareImageStyle } : {}),
  };
}

export async function recordShareImageNotification(userId: string, trip: Trip, style: TripShareImageStyle): Promise<GenerationNotification> {
  const now = new Date();
  const [row] = await db.insert(notifications).values({
    id: uid(), userId, jobId: uid(), kind: 'success', tripId: trip.id,
    destination: trip.destination, days: trip.days.length, shareImageStyle: style,
    title: `${trip.title} · 图片已生成`, message: '旅行海报已生成，可随时下载图片。',
    jobCreatedAt: now, createdAt: now,
  }).returning();
  if (!row) throw new Error('海报通知保存失败');
  publishNotification(userId, { kind: 'success', title: row.title, tripId: trip.id });
  return notificationView(row);
}

/**
 * 返回本次写入对应的推送事件，由调用方决定何时 publish。
 * `publish: false` 用于**事务内**写入：事务未提交时推送会让前端回查到空列表，
 * 调用方必须在 commit 之后自己调 publishNotification。
 */
export async function recordGenerationNotification(
  input: NewNotification,
  writer: Pick<typeof db, 'insert'> = db,
  options: { publish?: boolean } = {},
): Promise<NotificationEvent> {
  await writer.insert(notifications).values({ ...input, id: uid(), createdAt: new Date() })
    .onConflictDoNothing({ target: [notifications.userId, notifications.jobId] });
  const event: NotificationEvent = { kind: input.kind, title: input.title, tripId: input.tripId };
  if (options.publish !== false) publishNotification(input.userId, event);
  return event;
}

export async function listNotifications(userId: string, before?: number, limit = 20): Promise<NotificationPage> {
  // 列表、未读点和全部已读边界必须来自同一快照，避免读取中途到达的通知被误标已读。
  return db.transaction(async (tx) => {
    const owner = eq(notifications.userId, userId);
    const rows = await tx.select().from(notifications).where(and(owner, before === undefined ? undefined : lt(notifications.sequence, before)))
      .orderBy(desc(notifications.sequence)).limit(limit + 1);
    const unread = await tx.select({ id: notifications.id }).from(notifications).where(and(owner, isNull(notifications.readAt))).limit(1);
    const newest = await tx.select({ sequence: notifications.sequence }).from(notifications).where(owner).orderBy(desc(notifications.sequence)).limit(1);
    const page = rows.slice(0, limit);
    return {
      items: page.map(notificationView),
      hasUnread: unread.length > 0,
      readThrough: newest[0]?.sequence ?? 0,
      nextCursor: rows.length > limit ? page.at(-1)?.sequence ?? null : null,
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

export async function readNotification(userId: string, id: string): Promise<boolean> {
  const owner = and(eq(notifications.userId, userId), eq(notifications.id, id));
  await db.update(notifications).set({ readAt: new Date() }).where(and(owner, isNull(notifications.readAt)));
  const rows = await db.select({ id: notifications.id }).from(notifications).where(owner).limit(1);
  return rows.length > 0;
}

export async function readAllNotifications(userId: string, through: number): Promise<void> {
  await db.update(notifications).set({ readAt: new Date() }).where(and(
    eq(notifications.userId, userId), lte(notifications.sequence, through), isNull(notifications.readAt),
  ));
}

export async function getGenerationResult(userId: string, jobId: string): Promise<GenerationJobView | null> {
  const [row] = await db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.jobId, jobId), isNull(notifications.shareImageStyle))).limit(1);
  return row ? {
    jobId: row.jobId, status: row.kind === 'success' ? 'done' : 'error', tripId: row.tripId,
    createdAt: row.jobCreatedAt.getTime(), destination: row.destination, days: row.days, message: row.message,
  } : null;
}
