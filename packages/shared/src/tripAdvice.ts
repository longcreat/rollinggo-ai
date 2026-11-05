import { Type, type Static } from '@sinclair/typebox';
import type { Trip } from './types';

export const PersonalAdviceItemSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 40 }),
  text: Type.String({ minLength: 1, maxLength: 240 }),
  activityIds: Type.Array(Type.String(), { minItems: 1, maxItems: 12, uniqueItems: true }),
  sources: Type.Array(Type.Object({
    title: Type.String({ maxLength: 100 }),
    url: Type.String({ maxLength: 300, pattern: '^https?://' }),
  }), { maxItems: 6 }),
});

export const PersonalTripAdviceSchema = Type.Object({
  version: Type.Literal(1),
  generatedAt: Type.Number(),
  inputSnapshot: Type.String(),
  suggestions: Type.Array(PersonalAdviceItemSchema, { minItems: 1, maxItems: 4 }),
  cautions: Type.Array(PersonalAdviceItemSchema, { minItems: 1, maxItems: 4 }),
});
export type PersonalAdviceItem = Static<typeof PersonalAdviceItemSchema>;
export type PersonalTripAdvice = Static<typeof PersonalTripAdviceSchema>;

/** 只记录影响建议的输入。版本另存、改标题、封面与天气刷新不使建议过期。 */
export function tripAdviceInputSnapshot(trip: Trip): string {
  const lodging = (value: Trip['lodging']) => value ? [value.name, value.area, value.lat, value.lng] : null;
  return JSON.stringify({
    destination: trip.destination, startDate: trip.startDate,
    preferences: [...trip.preferences].sort(), extraNotes: trip.extraNotes,
    partySize: trip.partySize, budgetLevel: trip.budgetLevel, totalBudget: trip.totalBudget,
    transportMode: trip.transportMode ?? 'transit', lodging: lodging(trip.lodging),
    days: trip.days.map(day => ({
      dayIndex: day.dayIndex, lodging: lodging(day.lodging),
      activities: day.activities.map(a => [a.id, a.name, a.poiKey, a.description, a.category, a.startTime, a.endTime, a.lat, a.lng, a.openTime]),
      legs: day.legs?.map(l => [l.fromActivityId, l.toActivityId, l.mode, l.durationMin, l.distanceM]),
    })),
  });
}

export function personalAdviceIsCurrent(trip: Trip): boolean {
  return trip.meta.advice?.inputSnapshot === tripAdviceInputSnapshot(trip);
}
