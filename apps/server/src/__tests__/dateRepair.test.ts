import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isClosedOnDate, dateForDayIndex } from '@tripweaver/shared';
import { repairScheduleDates, DATE_REPAIR_LIMITS } from '../generation/scheduling/dateRepair';
import { buildSchedule, PACE_SCHEDULE_LIMITS, type SchedulablePoi } from '../generation/scheduling/schedule';
import { routeDistanceMeters } from '../generation/scheduling/routeOrder';

const point = (name: string, openTime?: string, weight = 2): SchedulablePoi => ({ id: name, name, category: 'attraction', score: 10, weight, openTime });
const options = { days: 2, foodFocused: false, startDate: '2026-10-19' };
const limits = PACE_SCHEDULE_LIMITS.moderate;
const verify = (before: SchedulablePoi[][], after: SchedulablePoi[][], startDate = options.startDate) => {
  assert.deepEqual(after.flat().map((p) => p.id).sort(), before.flat().map((p) => p.id).sort());
  assert.equal(new Set(after.flat().map((p) => p.id)).size, before.flat().length);
  after.forEach((day, i) => {
    assert.ok(day.length <= limits.maxStopsPerDay);
    assert.ok(day.reduce((sum, p) => sum + p.weight, 0) <= limits.dayWeightLimit);
    assert.ok(day.every((p) => !isClosedOnDate(p.openTime, dateForDayIndex(startDate, i + 1))));
  });
};

test('闭馆单点移到有容量的开放日，缺坐标也可修复且不修改输入', () => {
  const input = [[point('甲馆', '周一闭馆'), point('街区')], [point('乙馆', '周一闭馆')]];
  const frozen = structuredClone(input);
  const result = repairScheduleDates(input, options, limits);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.days[0]!.map((p) => p.name), ['街区']);
  verify(input, result.days);
  assert.deepEqual(input, frozen);
  assert.deepEqual(repairScheduleDates(input, options, limits), result);
});

test('容量已满时交换两天的单点，不能突破分量上限', () => {
  const input = [[point('甲馆', '周一闭馆', 4), point('甲街', undefined, 4)], [point('乙馆', '周一闭馆', 4), point('乙街', undefined, 4)]];
  const result = repairScheduleDates(input, options, limits);
  assert.deepEqual(result.conflicts, []);
  verify(input, result.days);
});

test('故宫景山先后组合整体交换两点，三个闭馆段重组保留十二点', () => {
  const input = [[point('故宫', '周一闭馆'), point('景山'), point('什刹海'), point('南锣')],
    [point('天坛', '周一闭馆'), point('雍和宫'), point('奥林匹克'), point('颐和园')],
    [point('鼓楼'), point('北海'), point('国博', '周一闭馆'), point('杨梅竹')]];
  const result = repairScheduleDates(input, { ...options, days: 3, orderConstraints: [{ before: '故宫', after: '景山' }] }, limits);
  assert.deepEqual(result.conflicts, []);
  verify(input, result.days);
  const palaceDay = result.days.find((day) => day.some((p) => p.name === '故宫'))!;
  assert.ok(palaceDay.findIndex((p) => p.name === '故宫') < palaceDay.findIndex((p) => p.name === '景山'));
});

test('不同闭馆日与跨日先后关系在修复中同时成立', () => {
  const input = [[point('甲馆', '周一闭馆'), point('前置')], [point('后置'), point('乙馆', '周三闭馆')], [point('公园')]];
  const result = repairScheduleDates(input, { ...options, days: 3, orderConstraints: [{ before: '前置', after: '后置' }] }, limits);
  assert.deepEqual(result.conflicts, []);
  verify(input, result.days);
  const all = result.days.flat().map((p) => p.name);
  assert.ok(all.indexOf('前置') < all.indexOf('后置'));
});

test('一日无解、独占点无法混排、循环约束均有限失败而不删点', () => {
  const single = [[point('馆', '周一闭馆')]];
  assert.equal(repairScheduleDates(single, { ...options, days: 1 }, limits).reason, 'no_open_day');
  const input = [[point('远郊', '周一闭馆')], [point('馆', '周一闭馆'), point('街区')]];
  const result = repairScheduleDates(input, { ...options, exclusiveNames: ['远郊'] }, limits);
  assert.ok(result.conflicts.length);
  assert.equal(result.days.flat().length, 3);
  assert.equal(result.days.find((day) => day.some((p) => p.name === '远郊'))!.length, 1);
  const cyclic = repairScheduleDates(input, { ...options, orderConstraints: [{ before: '馆', after: '街区' }, { before: '街区', after: '馆' }] }, limits);
  assert.ok(cyclic.conflicts.length);
  assert.ok(cyclic.attempts <= DATE_REPAIR_LIMITS.attempts);
});

test('法定假日及无日期保持原分组；15日输入有界', () => {
  const input = [[point('馆', '周一闭馆')], [point('公园')]];
  for (const startDate of [undefined, '2026-10-05']) {
    const result = repairScheduleDates(input, { ...options, startDate }, limits);
    assert.deepEqual(result.days, input);
    assert.equal(result.attempts, 0);
  }
  const many = Array.from({ length: 15 }, (_, i) => [point(`館${i}`, i === 0 ? '周一闭馆' : undefined), point(`街${i}`)]);
  const result = repairScheduleDates(many, { ...options, days: 15 }, limits);
  assert.deepEqual(result.conflicts, []);
  assert.ok(result.attempts <= DATE_REPAIR_LIMITS.attempts);
  verify(many, result.days);
});

test('不为避闭馆产生明显几何绕路', () => {
  const input = [[{ ...point('甲馆', '周一闭馆'), lat: 39.9, lng: 116.4 }, { ...point('甲街'), lat: 39.901, lng: 116.4 }],
    [{ ...point('乙馆', '周一闭馆'), lat: 40.9, lng: 117.4 }, { ...point('乙街'), lat: 40.901, lng: 117.4 }]];
  const result = repairScheduleDates(input, options, limits);
  assert.ok(result.conflicts.length, '唯一组合需要远距离混排时明确无法修复');
  assert.equal(result.days.flat().length, 4);
  assert.ok(result.days.reduce((sum, day) => sum + routeDistanceMeters(day), 0) < 1000);
});

test('景点日期重组后按实际日期重新选餐，午晚餐与唯一景点仍完整', () => {
  const attractions = ['甲馆', '甲街', '乙馆', '乙街'].map((name, i) => ({ ...point(name, i % 2 === 0 ? '周一闭馆' : undefined, 4), score: 100 - i, lat: 39.9, lng: 116.4 + i * 0.001 }));
  const food = { ...point('周一休息餐厅', '周一闭馆'), category: 'food' as const, lat: 39.9, lng: 116.401 };
  const result = buildSchedule([...attractions, food], { ...options, foodFocused: true });
  assert.deepEqual(result.closureConflicts, []);
  assert.equal(result.droppedCount, 0);
  assert.ok(result.dateRepair.attempts > 0);
  result.days.forEach((day, i) => {
    assert.deepEqual(day.stops.filter((s) => s.meal).map((s) => s.meal), ['lunch', 'dinner']);
    assert.ok(day.stops.every((s) => !isClosedOnDate(s.poi.openTime, dateForDayIndex(options.startDate, i + 1))));
  });
});
