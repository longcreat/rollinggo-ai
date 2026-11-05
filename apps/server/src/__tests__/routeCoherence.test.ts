import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LODGING_SENTINEL,
  effectiveLegMode,
  estimateTransit,
  haversineMeters,
  type Activity,
  type GenerateForm,
  type LegMode,
  type TransitLeg,
} from '@tripweaver/shared';
import { DraftTrip } from '../generation/draft';
import { optimizeCrossDayGrouping, repairTransitTiming } from '../generation/routeCoherence';

function form(): GenerateForm {
  return {
    destination: '乌兰察布',
    days: 2,
    startDate: '',
    budgetLevel: '舒适',
    totalBudget: 0,
    preferences: [],
    partySize: 3,
    extraNotes: '',
    transportMode: 'drive',
  };
}

interface ActivitySpec {
  name: string;
  startTime: string;
  endTime: string;
  lat: number;
  lng: number;
  category: Activity['category'];
}

function buildUlanqabDraft(): DraftTrip {
  const draft = new DraftTrip(form());
  draft.setSkeleton('乌兰察布2日自驾', ['火山与草原', '草原与火山']);
  const days: ActivitySpec[][] = [
    [
      { name: '乌兰哈达火山景区', startTime: '10:30', endTime: '13:00', lat: 41.555532, lng: 113.122579, category: '自然' },
      { name: '午餐｜乌兰哈达周边 · 当地风味', startTime: '13:00', endTime: '14:15', lat: 41.555532, lng: 113.122579, category: '美食' },
      { name: '辉腾锡勒草原', startTime: '15:30', endTime: '17:30', lat: 41.153146, lng: 112.622416, category: '自然' },
      { name: '晚餐｜辉腾锡勒周边 · 当地风味', startTime: '18:00', endTime: '19:15', lat: 41.153146, lng: 112.622416, category: '美食' },
    ],
    [
      { name: '黄花沟草原旅游度假区', startTime: '09:00', endTime: '12:00', lat: 41.130892, lng: 112.537638, category: '自然' },
      { name: '午餐｜黄花沟周边 · 莜面', startTime: '12:30', endTime: '13:30', lat: 41.130892, lng: 112.537638, category: '美食' },
      { name: '谷力脑包火山地质遗迹', startTime: '15:00', endTime: '16:30', lat: 40.85223, lng: 113.1849, category: '自然' },
      { name: '晚餐｜集宁市区 · 蒙餐', startTime: '17:30', endTime: '19:00', lat: 40.990413, lng: 113.155185, category: '美食' },
    ],
  ];
  days.forEach((specs, dayIndex) => {
    specs.forEach((spec) => draft.addActivity(dayIndex + 1, { ...spec, coordSource: 'geocoded' }));
  });
  draft.lodging = { name: '辉腾锡勒草原周边', lat: 41.163061, lng: 112.585942, coordSystem: 'gcj02' };
  return draft;
}

function heuristicRecompute(draft: DraftTrip) {
  return async (dayIndexes: readonly number[]): Promise<void> => {
    const pair = (from: { id: string; lat: number; lng: number }, to: { id: string; lat: number; lng: number }): TransitLeg => {
      const mode: LegMode = effectiveLegMode(from, to, 'drive');
      return { fromActivityId: from.id, toActivityId: to.id, mode, ...estimateTransit(from, to, mode), source: 'heuristic' };
    };
    for (const dayIndex of dayIndexes) {
      const day = draft.mutableDays()[dayIndex - 1]!;
      const legs: TransitLeg[] = [];
      for (let index = 0; index + 1 < day.activities.length; index += 1) {
        legs.push(pair(day.activities[index]!, day.activities[index + 1]!));
      }
      const lodging = draft.lodging;
      if (lodging && typeof lodging.lat === 'number' && typeof lodging.lng === 'number') {
        const lodgingPoint = { id: LODGING_SENTINEL, lat: lodging.lat, lng: lodging.lng };
        legs.unshift(pair(lodgingPoint, day.activities[0]!));
        legs.push(pair(day.activities.at(-1)!, lodgingPoint));
      }
      day.legs = legs;
    }
  };
}

function routeMinutes(draft: DraftTrip): number {
  return draft.mutableDays().flatMap((day) => day.legs ?? []).reduce((sum, leg) => sum + leg.durationMin, 0);
}

test('乌兰察布回归：跨天交换把相近草原集中，并降低总通勤且不增加 hard', async () => {
  const draft = buildUlanqabDraft();
  const recompute = heuristicRecompute(draft);
  await recompute([1, 2]);
  const routeBefore = routeMinutes(draft);
  const hardBefore = draft.feasibility().violations.filter((violation) => violation.severity === 'hard').length;

  const result = await optimizeCrossDayGrouping(draft, { mode: 'drive', recomputeLegs: recompute });

  assert.equal(result.notes.length, 1);
  const dayNames = draft.mutableDays().map((day) => day.activities.map((activity) => activity.name));
  const grasslandDay = dayNames.find((names) => names.includes('黄花沟草原旅游度假区'))!;
  const volcanoDay = dayNames.find((names) => names.includes('乌兰哈达火山景区'))!;
  assert.ok(grasslandDay.includes('辉腾锡勒草原'));
  assert.ok(volcanoDay.includes('谷力脑包火山地质遗迹'));
  assert.ok(routeMinutes(draft) <= routeBefore - 30);
  assert.ok(draft.feasibility().violations.filter((violation) => violation.severity === 'hard').length <= hardBefore);

  for (const day of draft.mutableDays()) {
    const validIds = new Set(day.activities.map((activity) => activity.id));
    for (const leg of day.legs ?? []) {
      assert.ok(leg.fromActivityId === LODGING_SENTINEL || validIds.has(leg.fromActivityId));
      assert.ok(leg.toActivityId === LODGING_SENTINEL || validIds.has(leg.toActivityId));
    }
  }
});

test('最终时间修复按真实 leg 顺延贴边午餐', async () => {
  const draft = buildUlanqabDraft();
  const recompute = heuristicRecompute(draft);
  await recompute([1, 2]);
  const changed = repairTransitTiming(draft.mutableDays());
  assert.ok(changed.includes(1));
  assert.equal(draft.mutableDays()[0]!.activities[1]!.startTime, '13:15');
  assert.equal(
    draft.feasibility().violations.some((violation) => violation.code === 'transit_infeasible' && violation.dayIndex === 1),
    false,
  );
});

test('跨天亲和判断对称：后一天地点更属于前一天时仍可交换', async () => {
  const draft = new DraftTrip(form());
  draft.setSkeleton('双向亲和回归', ['甲地', '乙地']);
  const specs: ActivitySpec[][] = [
    [
      { name: '甲地核心', startTime: '09:00', endTime: '10:00', lat: 40.9, lng: 113, category: '自然' },
      { name: '甲地边缘', startTime: '14:00', endTime: '15:00', lat: 40.9, lng: 113.24, category: '自然' },
    ],
    [
      { name: '误排的甲地近邻', startTime: '09:00', endTime: '10:00', lat: 40.9, lng: 113.02, category: '自然' },
      { name: '乙地核心', startTime: '14:00', endTime: '15:00', lat: 40.9, lng: 114.3, category: '自然' },
    ],
  ];
  specs.forEach((day, dayIndex) => {
    day.forEach((spec) => draft.addActivity(dayIndex + 1, { ...spec, coordSource: 'geocoded' }));
  });
  const recompute = heuristicRecompute(draft);
  await recompute([1, 2]);

  const result = await optimizeCrossDayGrouping(draft, { mode: 'drive', recomputeLegs: recompute });

  assert.equal(result.notes.length, 1);
  assert.deepEqual(
    draft.mutableDays()[0]!.activities.map((activity) => activity.name),
    ['甲地核心', '误排的甲地近邻'],
  );
  assert.deepEqual(
    draft.mutableDays()[1]!.activities.map((activity) => activity.name),
    ['甲地边缘', '乙地核心'],
  );
});

test('路线重算异常时逐字节回滚，并按可选优化降级', async () => {
  const draft = buildUlanqabDraft();
  const recompute = heuristicRecompute(draft);
  await recompute([1, 2]);
  const before = JSON.stringify(draft.mutableDays());

  const result = await optimizeCrossDayGrouping(draft, {
    mode: 'drive',
    recomputeLegs: async (dayIndexes) => {
      for (const dayIndex of dayIndexes) draft.mutableDays()[dayIndex - 1]!.legs = [];
      throw new Error('route unavailable');
    },
  });

  assert.deepEqual(result, { notes: [], changedDayIndexes: [] });
  assert.equal(JSON.stringify(draft.mutableDays()), before);
});

test('跨天地理优化保留取消语义', async () => {
  const draft = buildUlanqabDraft();
  const recompute = heuristicRecompute(draft);
  await recompute([1, 2]);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    optimizeCrossDayGrouping(draft, { mode: 'drive', recomputeLegs: recompute, signal: controller.signal }),
    /已取消/,
  );
});
