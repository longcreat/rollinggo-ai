import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import { Value } from '@sinclair/typebox/value';
import {
  TripSchema,
  uid,
  type Trip,
  type TripListItem,
  type TripListPage,
  type TripListSort,
  type TripVersionChain,
} from '@tripweaver/shared';
import { db } from '../db/client';
import { trips, users } from '../db/schema';
import { commitOperation, operationFingerprint } from './detailOperationService';

export type TripWriter = Pick<typeof db, 'select' | 'insert' | 'update'>;

/** 所有版本创建与原地保存共用用户行锁，包括尚无版本链的首次创建。 */
export async function lockTripWriter(userId: string, writer: TripWriter) {
  await writer.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
}

export async function assertLatestTrip(userId: string, id: string, updatedAt?: number, writer: TripWriter = db) {
  const [target] = await writer.select().from(trips).where(and(eq(trips.id, id), eq(trips.userId, userId)));
  if (!target) throw Object.assign(new Error('行程不存在'), { statusCode: 404 });
  const [latest] = await writer.select({ id: trips.id }).from(trips)
    .where(and(eq(trips.rootId, target.rootId), eq(trips.userId, userId))).orderBy(desc(trips.version)).limit(1);
  if (latest?.id !== id || (updatedAt !== undefined && target.updatedAt.getTime() !== updatedAt)) {
    throw Object.assign(new Error('行程已有新版本或修改，请刷新后重试'), { statusCode: 409 });
  }
  return target;
}

function summarize(trip: Trip) {
  // 冗余列 total_cost：粗估合计（cost 可选化后缺省按 0 计，仅供列表页「约 ¥」展示）
  const totalCost = trip.days.reduce((n, d) => n + d.activities.reduce((m, a) => m + (a.cost ?? 0), 0), 0);
  return {
    title: trip.title,
    destination: trip.destination,
    daysCount: trip.days.length,
    activityCount: trip.days.reduce((n, d) => n + d.activities.length, 0),
    totalCost: Math.round(totalCost),
    usedXhs: trip.meta.usedXhs,
  };
}

function toListItem(row: typeof trips.$inferSelect): TripListItem {
  return {
    id: row.id,
    title: row.title,
    destination: row.destination,
    daysCount: row.daysCount,
    activityCount: row.activityCount,
    totalCost: row.totalCost,
    usedXhs: row.usedXhs,
    version: row.version,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** LIKE 元字符转义：用户输入不能被当成通配符（口径同 generation/placeRetrieval） */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

export interface TripListQuery {
  offset: number;
  limit: number;
  q?: string | undefined;
  city?: string | undefined;
  sort?: TripListSort | undefined;
}

/**
 * 行程列表分页（10-03）：每条版本链只返回最新版，筛选/排序/计数全在 SQL 里做。
 * 内层 `distinct on (root_id)` 只按 user_id 过滤，筛选放到外层 ——
 * WHERE 在 DISTINCT ON 之前求值，混在一层会让旧版本命中筛选词后把旧内容当最新版返回。
 */
export async function listTripsPage(userId: string, query: TripListQuery): Promise<TripListPage> {
  const latest = db
    .selectDistinctOn([trips.rootId])
    .from(trips)
    .where(eq(trips.userId, userId))
    .orderBy(trips.rootId, desc(trips.version))
    .as('latest');

  const filters: SQL[] = [];
  const city = query.city?.trim();
  if (city) filters.push(eq(latest.destination, city));
  const keyword = query.q?.trim();
  if (keyword) {
    const pattern = `%${escapeLike(keyword)}%`;
    filters.push(or(ilike(latest.title, pattern), ilike(latest.destination, pattern))!);
  }
  const where = filters.length ? and(...filters) : undefined;

  // 三种排序都以 title/id 收尾，等值时 offset 分页不会跨页重复或漏项
  const order = query.sort === 'name'
    ? [asc(latest.title), asc(latest.id)]
    : query.sort === 'created'
      ? [desc(latest.createdAt), asc(latest.title), asc(latest.id)]
      : [desc(latest.updatedAt), asc(latest.title), asc(latest.id)];

  const [rows, counted, destinations] = await Promise.all([
    db.select().from(latest).where(where).orderBy(...order).limit(query.limit).offset(query.offset),
    db.select({ n: sql<number>`count(*)::int` }).from(latest).where(where),
    db.selectDistinct({ destination: trips.destination }).from(trips).where(eq(trips.userId, userId)).orderBy(asc(trips.destination)),
  ]);

  return {
    items: rows.map(toListItem),
    total: Number(counted[0]?.n ?? 0),
    destinations: destinations.map((row) => row.destination),
  };
}

/** 版本链（含历史版本）；非本人或不存在返回 null，路由统一 404 */
export async function listTripVersions(userId: string, id: string): Promise<TripVersionChain | null> {
  const [anchor] = await db
    .select({ rootId: trips.rootId })
    .from(trips)
    .where(and(eq(trips.id, id), eq(trips.userId, userId)));
  if (!anchor) return null;
  const rows = await db
    .select({ id: trips.id, version: trips.version, title: trips.title, createdAt: trips.createdAt, summary: trips.changeSummary })
    .from(trips)
    .where(and(eq(trips.rootId, anchor.rootId), eq(trips.userId, userId)))
    .orderBy(asc(trips.version));
  return {
    rootId: anchor.rootId,
    versions: rows.map(({ summary, ...row }) => ({ ...row, ...(summary ? { summary } : {}), createdAt: row.createdAt.getTime() })),
  };
}

export async function getTrip(userId: string, id: string): Promise<Trip | null> {
  const [row] = await db.select().from(trips).where(and(eq(trips.id, id), eq(trips.userId, userId)));
  return row ? (row.data as Trip) : null;
}

/** 新建（导入 / 生成落库共用）：分配新 id 与时间戳，归属当前用户；全新行程自为版本链根 */
export async function createTrip(userId: string, source: Trip, revisionOf?: string, writer: TripWriter = db): Promise<Trip> {
  if (writer === db) return db.transaction((tx) => createTrip(userId, source, revisionOf, tx));
  await lockTripWriter(userId, writer);
  const nowMs = Date.now();
  const now = new Date(nowMs);
  const trip: Trip = { ...source, id: uid(), createdAt: nowMs, updatedAt: nowMs };
  // 修订（PR5）：新行程挂到被修订行程所在版本链的下一版，旧版原样保留
  const lineage = revisionOf
    ? await revisionLineage(userId, revisionOf, writer)
    : { rootId: trip.id, version: 1, parentId: null as string | null };
  await writer.insert(trips).values({
    id: trip.id,
    userId,
    ...summarize(trip),
    rootId: lineage.rootId,
    version: lineage.version,
    parentId: lineage.parentId,
    data: trip,
    createdAt: now,
    updatedAt: now,
  });
  return trip;
}

/** 版本链血缘：目标行程必须属于当前用户（越权与非存在返回同一个 404 语义） */
async function revisionLineage(
  userId: string,
  targetTripId: string,
  writer: TripWriter,
): Promise<{ rootId: string; version: number; parentId: string }> {
  await assertLatestTrip(userId, targetTripId, undefined, writer);
  const [target] = await writer
    .select({ rootId: trips.rootId, version: trips.version })
    .from(trips)
    .where(and(eq(trips.id, targetTripId), eq(trips.userId, userId)));
  if (!target) throw Object.assign(new Error('被修订的行程不存在'), { statusCode: 404 });
  return { rootId: target.rootId, version: target.version + 1, parentId: targetTripId };
}

export async function updateTrip(userId: string, id: string, incoming: Trip): Promise<Trip> {
  // 同一快照的断线重试返回原结果，不能再次创建版本；指纹包含原版本与时间戳。
  const fingerprint = operationFingerprint('manual-save', [id, incoming]);
  const result = await commitOperation(userId, `save:${fingerprint}`, fingerprint, async (tx) => {
    const existing = await assertLatestTrip(userId, id, incoming.updatedAt, tx);
    if (!Value.Check(TripSchema, existing.data)) throw new Error('行程数据无效');
    const previous = existing.data;
    const content = ({ id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest }: Trip) => rest;
    if (isDeepStrictEqual(content(previous), content(incoming))) return previous;
    const trip = await createTrip(userId, incoming, id, tx);
    await tx.update(trips).set({ changeSummary: '手动修改行程' })
      .where(and(eq(trips.id, trip.id), eq(trips.userId, userId)));
    return trip;
  });
  if (!Value.Check(TripSchema, result)) throw new Error('保存结果无效');
  return result;
}

export async function renameTrip(userId: string, id: string, title: string): Promise<boolean> {
  const trip = await getTrip(userId, id);
  if (!trip) return false;
  return (await updateTrip(userId, id, { ...trip, title })) !== null;
}

/** 删除整条版本链：列表与历史面板都按行程（rootId）工作，传链上任意版本 id 即删除该行程的全部版本。 */
export async function deleteTrip(userId: string, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    // 与其他创建路径共用用户行锁，避免删除整链时并发插入新版本
    await lockTripWriter(userId, tx);
    const [anchor] = await tx.select({ rootId: trips.rootId }).from(trips).where(and(eq(trips.id, id), eq(trips.userId, userId)));
    if (!anchor) return false;
    await tx.delete(trips).where(and(eq(trips.userId, userId), eq(trips.rootId, anchor.rootId)));
    return true;
  });
}
