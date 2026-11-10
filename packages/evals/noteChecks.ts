import type { Trip } from '@tripweaver/shared';
import { NOTE_EXPECTATIONS } from './scenarios';

/** 仅判定可直接观察的必去/避开地点；口味、无障碍等不能靠名称宣布满足。 */
export function checkNotePlaces(caseId: string, trip: Trip): string[] {
  const rule = NOTE_EXPECTATIONS.find((r) => caseId === `beijing-notes-${r.id}`);
  if (!rule) return [];
  const names = new Set(trip.days.flatMap((d) => d.activities.map((a) => a.name.trim())));
  const errors: string[] = [];
  if (rule.require.length && !rule.require.some((n) => names.has(n))) errors.push(`备注明确必去，但最终未安排：${rule.require.join(' / ')}`);
  for (const name of rule.avoid) if (names.has(name)) errors.push(`备注明确避开，但最终仍安排：${name}`);
  return errors;
}
