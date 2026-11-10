import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTrimRemovals, daySpanMinutes, planOverpackedTrim } from '@tripweaver/agent/generation/dayTrim';

const day = (activities: { id: string; name: string; category?: string; startTime: string; endTime: string }[]) => ({ activities });

test('14h 的一天：移除最长的非首站景点，保留首站与餐次', () => {
  const target = day([
    { id: 'a', name: '首站', category: '文化', startTime: '09:00', endTime: '12:00' },
    { id: 'lunch', name: '午餐', category: '美食', startTime: '12:00', endTime: '13:00' },
    { id: 'b', name: '博物馆', category: '文化', startTime: '13:00', endTime: '16:00' },
    { id: 'c', name: '街区', category: '文化', startTime: '16:00', endTime: '19:00' },
    { id: 'dinner', name: '晚餐', category: '美食', startTime: '19:00', endTime: '20:00' },
    { id: 'd', name: '夜游', category: '自然', startTime: '20:00', endTime: '23:00' },
  ]);
  assert.equal(daySpanMinutes(target), 14 * 60);
  const plan = planOverpackedTrim([target]);
  assert.equal(plan.removals.length, 1);
  assert.equal(plan.removals[0]!.activityId, 'b');
  assert.match(plan.notes[0] ?? '', /已精简第1天：移除「博物馆」/);
  assert.deepEqual(plan.dayIndexes, [1]);
});

test('12h 以内不动；首站与餐次不会被优先移除', () => {
  const healthy = day([
    { id: 'a', name: '首站', category: '文化', startTime: '09:00', endTime: '11:00' },
    { id: 'lunch', name: '午餐', category: '美食', startTime: '11:00', endTime: '12:00' },
    { id: 'b', name: '次站', category: '文化', startTime: '12:00', endTime: '14:00' },
  ]);
  assert.deepEqual(planOverpackedTrim([healthy]).removals, []);

  const long = day([
    { id: 'only-meal', name: '晚餐', category: '美食', startTime: '09:00', endTime: '20:00' },
    { id: 'x', name: '次站', category: '文化', startTime: '20:00', endTime: '22:00' },
  ]);
  const plan = planOverpackedTrim([long]);
  assert.equal(plan.removals.every((item) => item.activityId !== 'only-meal'), true, '餐次不应先于景点被移除');
});

test('applyTrimRemovals 删除活动与相邻 legs，并返回受影响的天', () => {
  const days = [{
    activities: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
    legs: [{ fromActivityId: 'a', toActivityId: 'b' }, { fromActivityId: 'b', toActivityId: 'c' }],
  }];
  const touched = applyTrimRemovals(days, [{ dayIndex: 1, activityId: 'b', name: 'B', minutes: 60 }]);
  assert.deepEqual(touched, [1]);
  assert.deepEqual(days[0]!.activities.map((item) => item.id), ['a', 'c']);
  assert.deepEqual(days[0]!.legs, []);
});
