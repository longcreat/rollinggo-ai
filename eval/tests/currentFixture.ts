import { makeSampleTrip } from '@tripweaver/shared';
import type { GoldenCase } from '../golden/cases';
import type { Snapshot } from '../contracts';

export function currentFixture(gc: GoldenCase): Snapshot {
  const trip = makeSampleTrip(1_700_000_000_000);
  const { days: _days, lodging: _lodging, ...persisted } = gc.form;
  Object.assign(trip, persisted);
  delete trip.lodging;
  if (gc.form.lodging) trip.lodging = { name: gc.form.lodging };
  const activity = trip.days[0]!.activities[0]!;
  trip.days = Array.from({ length: gc.form.days }, (_, i) => ({ id: `day-${i}`, dayIndex: i + 1, title: '行程',
    activities: ['景点', '午餐｜景点周边', '晚餐｜景点周边'].map((name, j) => ({ ...activity,
      id: `act-${i}-${j}`, name, category: j ? '美食' as const : '文化' as const, startTime: '', endTime: '' })) }));
  return { schemaVersion: 3, caseId: gc.id, form: gc.form, trip, model: 'test', generatedAt: 1,
    research: { candidates: [{ id: 'poi', name: '景点', category: 'attraction', intro: '测试', reservation: 'unknown', sourceLinks: [] }] },
    timing: { phases: { 'research#1': 1, 'plan#1': 1, 'review#1': 1 }, totalMs: 3, tokensIn: 1, tokensOut: 1,
      providerCalls: { amap: 0, search: 0, xhs: 0 } },
    execution: { terminal: 'done', tripReadBack: true, auditCommitted: true, overviewMatches: true, planLlmCalls: 0,
      tasks: Object.fromEntries(['prefetch_verified_places', 'submit_research', 'schedule_itinerary', 'update_titles',
        'geo_geocode_all', 'optimize_day_routes', 'geo_compute_legs', 'simulate_feasibility', 'repair_long_haul',
        'optimize_cross_day_grouping', 'geo_geocode_review_changes', 'geo_recompute_final_legs'].map((name) => [name, { ok: 1, errors: 0 }])) } };
}
