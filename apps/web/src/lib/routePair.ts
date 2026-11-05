import type { Activity, Trip } from '@tripweaver/shared';

export function routePairKey(trip: Trip, dayId: string, fromId: string): string | null {
  const day = trip.days.find((d) => d.id === dayId);
  const index = day?.activities.findIndex((a) => a.id === fromId) ?? -1;
  const from = day?.activities[index];
  const to = day?.activities[index + 1];
  if (index < 0 || !from || !to) return null;
  const point = (a: Activity) => [a.id, a.name, a.lat, a.lng, a.coordSystem ?? 'wgs84'];
  return JSON.stringify([trip.id, trip.destination, dayId, point(from), point(to)]);
}
