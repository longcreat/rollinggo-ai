import { and, eq } from 'drizzle-orm';
import { Value } from '@sinclair/typebox/value';
import { foodAlreadyAdded, foodPositionProblem, foodTimes, ChatAttachmentSchema, TripOperationResultSchema, TripSchema, MEAL_LABELS, effectiveLegMode, estimateTransit, wgs84ToGcj02, uid, type AddFoodRequest, type FoodCandidate, type Trip, type TripOperationRequest } from '@tripweaver/shared';
import { db } from '../db/client';
import { chatMessages, trips } from '../db/schema';
import { appendMessages, createConversation, findConversationForTrip, saveBrief, syncConversationTripDates } from './conversationService';
import { assertLatestTrip, createTrip, getTrip, lockTripWriter } from './tripService';
import { commitOperation, operationFingerprint, readOperation } from './detailOperationService';
import { getRouteOptions } from './routeOptionsService';
import { dayNeedsRouteRepair, routePairsFor } from './routeRepairPlan';

export async function ensureTripConversation(userId: string, tripId: string) {
  return db.transaction(async (tx) => {
    await lockTripWriter(userId, tx);
    const target = await assertLatestTrip(userId, tripId, undefined, tx);
    const existing = await findConversationForTrip(userId, tripId);
    if (existing) return { conversationId: existing };
    if (!Value.Check(TripSchema, target.data)) throw new Error('行程数据无效');
    const trip = target.data;
    const conversation = await createConversation(userId, trip.title, tx);
    await saveBrief(userId, conversation.id, { destination: trip.destination, startDate: trip.startDate, days: Math.max(1, trip.days.length), partySize: trip.partySize, extraNotes: trip.extraNotes, transportMode: trip.transportMode, constraints: [] }, 'submitted', tx);
    await appendMessages({ userId, conversationId: conversation.id, messages: [{ role: 'assistant', content: '已关联当前行程，可以继续完善沿途安排。', relatedTripId: trip.id }] }, tx);
    return { conversationId: conversation.id };
  });
}

export async function restoreTrip(userId: string, sourceId: string, input: TripOperationRequest) {
  const fingerprint = operationFingerprint('restore', [sourceId, input]);
  const old = await readOperation(userId, input.operationId, fingerprint);
  if (old) return old;
  const conversationId = await findConversationForTrip(userId, input.expectedTripId);
  return commitOperation(userId, input.operationId, fingerprint, async (tx) => {
    const latest = await assertLatestTrip(userId, input.expectedTripId, input.updatedAt, tx);
    const [source] = await tx.select().from(trips).where(and(eq(trips.id, sourceId), eq(trips.userId, userId), eq(trips.rootId, latest.rootId)));
    if (!source) throw Object.assign(new Error('历史版本不存在'), { statusCode: 404 });
    if (source.id === latest.id) throw Object.assign(new Error('当前已是最新版本'), { statusCode: 409 });
    if (!Value.Check(TripSchema, source.data)) throw new Error('历史行程数据无效');
    const trip = await createTrip(userId, source.data, latest.id, tx);
    const summary = `已从 v${source.version} 恢复为 v${latest.version + 1}`;
    await tx.update(trips).set({ changeSummary: summary }).where(and(eq(trips.id, trip.id), eq(trips.userId, userId)));
    if (conversationId) {
      const messages = await appendMessages({ userId, conversationId, messages: [{ role: 'assistant', content: summary, relatedTripId: trip.id }] }, tx);
      if (!messages) throw Object.assign(new Error('关联会话已不存在'), { statusCode: 404 });
      await syncConversationTripDates(userId, conversationId, trip, tx);
    }
    return { trip, version: latest.version + 1 };
  });
}

async function findFoodCandidate(userId: string, conversationId: string, candidateId: string): Promise<FoodCandidate | null> {
  const rows = await db.select({ attachment: chatMessages.attachment }).from(chatMessages)
    .where(and(eq(chatMessages.userId, userId), eq(chatMessages.conversationId, conversationId)));
  for (const row of rows) {
    if (!Value.Check(ChatAttachmentSchema, row.attachment)) continue;
    const candidate = row.attachment.candidates.find((c) => c.id === candidateId);
    if (candidate) return candidate;
  }
  return null;
}

/** 重算变动的相邻边，保持旧活动和未变路线；路线服务无结果时明示 heuristic。 */
export async function repairChangedRoutes(userId: string, previous: Trip, next: Trip, signal?: AbortSignal) {
  for (const day of next.days) {
    const old = previous.days.find((d) => d.id === day.id);
    if (!dayNeedsRouteRepair(old, day, next)) continue;
    const pairs = routePairsFor(day, next);
    // 先丢掉过期 leg：端点不再相邻，或出行方式已变
    day.legs = (day.legs ?? []).filter((leg) => pairs.some((pair) => pair.from.id === leg.fromActivityId
      && pair.to.id === leg.toActivityId && pair.mode === leg.mode));
    for (const pair of pairs) {
      signal?.throwIfAborted();
      if (day.legs.some((leg) => leg.fromActivityId === pair.from.id && leg.toActivityId === pair.to.id)) continue;
      const options = await getRouteOptions(userId, { from: pair.from, to: pair.to, destination: next.destination, mode: pair.mode });
      const available = options.options.find((option) => option.status === 'available');
      day.legs.push(available?.status === 'available' ? available.leg : {
        fromActivityId: pair.from.id, toActivityId: pair.to.id, mode: pair.mode,
        ...estimateTransit(pair.origin, pair.dest, pair.mode), source: 'heuristic',
      });
    }
  }
}

export async function addFood(userId: string, conversationId: string, input: AddFoodRequest) {
  const fingerprint = operationFingerprint('food', [conversationId, input]);
  const old = await readOperation(userId, input.operationId, fingerprint);
  if (old) return old;
  const linked = await findConversationForTrip(userId, input.expectedTripId);
  if (linked !== conversationId) throw Object.assign(new Error('行程或会话不存在'), { statusCode: 404 });
  const candidate = await findFoodCandidate(userId, conversationId, input.candidateId);
  const current = await getTrip(userId, input.expectedTripId);
  if (!candidate || !current) throw Object.assign(new Error('推荐地点已不可用，请重新查询'), { statusCode: 404 });
  const anchor = await assertLatestTrip(userId, current.id, input.updatedAt);
  const [source] = await db.select({ rootId: trips.rootId }).from(trips).where(and(eq(trips.id, candidate.tripId), eq(trips.userId, userId)));
  if (source?.rootId !== anchor.rootId) throw Object.assign(new Error('推荐地点不属于当前行程'), { statusCode: 404 });
  const day = current.days.find((d) => d.id === input.position.dayId);
  const exists = day && foodAlreadyAdded(day, candidate);
  let next = current;
  let activityId = exists?.id;
  if (!exists) {
    const problem = foodPositionProblem(current, candidate, input.position);
    if (problem) throw Object.assign(new Error(problem), { statusCode: 409 });
    next = structuredClone(current);
    const target = next.days.find((d) => d.id === input.position.dayId)!;
    activityId = uid();
    const index = input.position.beforeActivityId ? target.activities.findIndex((a) => a.id === input.position.beforeActivityId) : target.activities.length;
    target.activities.splice(index, 0, {
      id: activityId, poiKey: candidate.poiKey, name: candidate.name, startTime: '', endTime: '',
      description: `${MEAL_LABELS[input.position.meal]} · ${candidate.address || candidate.reason}`.slice(0, 500),
      lat: candidate.lat, lng: candidate.lng, coordSystem: 'gcj02', coordSource: 'geocoded', category: '美食',
      sourceNotes: candidate.sources, ...(candidate.openTime ? { openTime: candidate.openTime } : {}),
    });
    await repairChangedRoutes(userId, current, next);
    try {
      const inbound = target.legs?.find((l) => l.toActivityId === activityId)?.durationMin ?? 0;
      const outbound = target.legs?.find((l) => l.fromActivityId === activityId)?.durationMin ?? 0;
      Object.assign(target.activities[index]!, foodTimes(current, candidate, input.position, inbound, outbound));
    } catch (error) { throw Object.assign(error instanceof Error ? error : new Error('用餐时间冲突'), { statusCode: 409 }); }
  }
  const result = await commitOperation(userId, input.operationId, fingerprint, async (tx) => {
    const latest = await assertLatestTrip(userId, current.id, input.updatedAt, tx);
    const trip = exists ? current : await createTrip(userId, next, current.id, tx);
    if (!exists) {
      const summary = `第 ${day!.dayIndex} 天：添加${MEAL_LABELS[input.position.meal]}「${candidate.name}」`;
      await tx.update(trips).set({ changeSummary: summary }).where(and(eq(trips.id, trip.id), eq(trips.userId, userId)));
      const messages = await appendMessages({ userId, conversationId, messages: [{
        role: 'assistant', content: summary, relatedTripId: trip.id,
        attachment: { tripId: trip.id, dayId: input.position.dayId, summary: [], candidates: [], suggestions: [
          { label: '看看用餐前后怎么走', text: `第 ${day!.dayIndex} 天在「${candidate.name}」吃${MEAL_LABELS[input.position.meal]}，前后景点的交通怎么安排？`, kind: 'follow_up' },
          { label: '检查用餐后的行程节奏', text: `第 ${day!.dayIndex} 天加入「${candidate.name}」作为${MEAL_LABELS[input.position.meal]}后，行程节奏是否合理？先给建议。`, kind: 'pace' },
        ] },
      }] }, tx);
      if (!messages) throw Object.assign(new Error('关联会话已不存在'), { statusCode: 404 });
    }
    return { trip, version: latest.version + (exists ? 0 : 1), activityId, dayId: input.position.dayId, alreadyExists: Boolean(exists) };
  });
  if (!Value.Check(TripOperationResultSchema, result)) throw new Error('添加结果无效');
  return result;
}
