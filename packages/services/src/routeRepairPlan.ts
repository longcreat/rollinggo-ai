// 通勤动线重算的纯判定：不读库、不发请求，便于单测钉住「哪些情形必须重算」。
//
// 背景（2026-11-05）：旧实现只在「活动 id 列表变化」时重算，于是
//   · 只改活动名（改名为另一个地点）会清空当天 legs，却永远不会被补回；
//   · 只改出行方式（transit → drive）会清空全行程 legs，同样补不回来。
// 两种情况下地图动线永久为空。这里把判定改成「相邻对是否齐全 + 方式是否匹配」。
import { effectiveLegMode, wgs84ToGcj02, type Activity, type LegMode, type Trip, type TripDay } from '@rollinggo-trip/shared';

/** 当天应存在的相邻通勤对：住宿 → 首活动 → … → 末活动 → 住宿；无坐标的端点跳过。 */
export interface RoutePair {
  from: Activity;
  to: Activity;
  origin: { lat: number; lng: number; coordSystem?: string };
  dest: { lat: number; lng: number; coordSystem?: string };
  mode: LegMode;
}

export function routePairsFor(day: TripDay, trip: Trip): RoutePair[] {
  const lodging = day.lodging ?? trip.lodging;
  const lodgingActivity = lodging && typeof lodging.lat === 'number' && typeof lodging.lng === 'number' ? {
    id: 'lodging', name: lodging.name, lat: lodging.lat, lng: lodging.lng, coordSystem: lodging.coordSystem,
    coordSource: 'geocoded' as const, category: '住宿' as const, startTime: '', endTime: '', description: '', sourceNotes: [],
  } : undefined;
  const points = lodgingActivity && day.activities.length ? [lodgingActivity, ...day.activities, lodgingActivity] : day.activities;
  const pairs: RoutePair[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]!;
    const to = points[i + 1]!;
    if ([from, to].some((point) => point.lat === 0 && point.lng === 0)) continue;
    const origin = from.coordSystem === 'gcj02' ? from : wgs84ToGcj02(from.lat, from.lng);
    const dest = to.coordSystem === 'gcj02' ? to : wgs84ToGcj02(to.lat, to.lng);
    pairs.push({ from, to, origin, dest, mode: effectiveLegMode(origin, dest, trip.transportMode ?? 'transit') });
  }
  return pairs;
}

/** 活动集合/顺序变了、缺 leg、leg 的方式与当前基调不符，三者任一都需要重算。 */
export function dayNeedsRouteRepair(previousDay: TripDay | undefined, day: TripDay, trip: Trip): boolean {
  const ids = day.activities.map((activity) => activity.id).join('|');
  if ((previousDay?.activities.map((activity) => activity.id).join('|') ?? '') !== ids) return true;
  const legs = day.legs ?? [];
  return routePairsFor(day, trip).some(({ from, to, mode }) => {
    const leg = legs.find((item) => item.fromActivityId === from.id && item.toActivityId === to.id);
    return !leg || leg.mode !== mode;
  });
}
