// 生成直播：把 SSE 事件合成一份「正在生成的 Trip」，供行程栏与地图逐日渲染。
//
// 只用 job_start + plan_day 两类事件：plan_day 由规划 Agent 每排完一天推送，
// 携带真实坐标与起止时刻。最终行程仍以 job_done 后拉取的 Trip 为准，这里的数据只读。
import type { ActivityCategory, GenerationEvent, Trip, TripDay } from '@tripweaver/shared';

export const LIVE_TRIP_ID = 'live';

type PlanDayEvent = Extract<GenerationEvent, { type: 'plan_day' }>;
type JobStartEvent = Extract<GenerationEvent, { type: 'job_start' }>;

function skeleton(event: JobStartEvent): Trip {
  const dayCount = Math.max(1, Math.min(15, event.days ?? 1));
  const days: TripDay[] = Array.from({ length: dayCount }, (_, index) => ({
    id: `live-day-${index + 1}`,
    dayIndex: index + 1,
    title: '',
    activities: [],
  }));
  return {
    id: LIVE_TRIP_ID,
    title: `${event.destination} · 生成中`,
    destination: event.destination,
    startDate: event.startDate ?? '',
    budgetLevel: '舒适',
    totalBudget: 0,
    preferences: [],
    partySize: 2,
    extraNotes: '',
    transportMode: 'transit',
    days,
    overview: [],
    meta: { usedXhs: false, reviewNotes: [] },
    createdAt: 0,
    updatedAt: 0,
  };
}

/** 同一天重复 plan_day（Agent 修正）时整体替换，活动 id 只随顺序变化，保持渲染稳定。 */
export function applyPlanDay(trip: Trip, event: PlanDayEvent): Trip {
  const index = event.dayIndex - 1;
  const day = trip.days[index];
  if (!day) return trip;
  const activities = event.stops.map((stop, stopIndex) => ({
    id: `live-${event.dayIndex}-${stopIndex}`,
    name: stop.name,
    startTime: stop.startTime,
    endTime: stop.endTime,
    description: '',
    lat: stop.lat,
    lng: stop.lng,
    coordSource: 'geocoded' as const,
    coordSystem: 'gcj02' as const,
    category: stop.category as ActivityCategory,
    sourceNotes: [],
  }));
  const days = [...trip.days];
  days[index] = { ...day, ...(event.title ? { title: event.title } : {}), activities };
  return { ...trip, days, updatedAt: (trip.updatedAt ?? 0) + 1 };
}

/** 从事件流重建直播用的合成行程；没有 job_start 时返回 null。 */
export function buildLiveTrip(events: readonly GenerationEvent[]): Trip | null {
  let trip: Trip | null = null;
  for (const event of events) {
    if (event.type === 'job_start') trip = skeleton(event);
    else if (event.type === 'plan_day' && trip) trip = applyPlanDay(trip, event);
  }
  return trip;
}
