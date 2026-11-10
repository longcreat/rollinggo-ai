// 一天的时距排布：通勤、停留、闭馆都按注入的数值推演，不做地理计算。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dwellMinutes, formatClock, parseClock, scheduleDays, walkingMinutes } from '@rollinggo-trip/services/itinerary/schedule';
import { planDay } from '@rollinggo-trip/agent/generation/scheduling/dayPlanner';

const stop = (id: string, name: string, lat = 30.25, lng = 120.15, extra: Record<string, unknown> = {}) => ({
  id, name, lat, lng, ...extra,
});

test('时刻解析与格式化', () => {
  assert.equal(parseClock('09:05'), 545);
  assert.equal(parseClock('9:05'), 545);
  assert.equal(parseClock('25:00'), null);
  assert.equal(parseClock(''), null);
  assert.equal(formatClock(545), '09:05');
  assert.equal(formatClock(1290), '21:30');
});

test('按注入的通勤时长与节奏排布一天', async () => {
  const result = await planDay({
    dayIndex: 1, startDate: '2026-11-09', startAt: '09:00', pace: 'moderate',
    stops: [stop('a', '断桥残雪'), stop('b', '白堤'), stop('c', '苏堤')],
    travelMinutes: async (from) => (from.id === 'a' ? 15 : 20),
  });
  assert.deepEqual(result.timed.map((item) => [item.name, item.arrive, item.leave]), [
    ['断桥残雪', '09:00', '10:15'],
    ['白堤', '10:30', '11:45'],
    ['苏堤', '12:05', '13:20'],
  ]);
  assert.equal(result.totalTravelMin, 35);
  assert.equal(result.endAt, '13:20');
  assert.deepEqual(result.issues, []);
});

test('路线不可得时按步行兜底并给出提示', async () => {
  const result = await planDay({
    dayIndex: 1, startDate: '2026-11-09', startAt: '09:00', pace: 'relaxed',
    stops: [stop('a', 'A', 30.25, 120.15), stop('b', 'B', 30.26, 120.15)],
    travelMinutes: async () => null,
  });
  const expected = walkingMinutes(stop('a', 'A', 30.25, 120.15), stop('b', 'B', 30.26, 120.15));
  assert.equal(result.timed[1]!.travelMin, expected);
  assert.ok(result.issues.some((item) => item.includes('按步行估算')));
});

test('闭馆日与过满给出 issue，不抛错', async () => {
  const closed = await planDay({
    dayIndex: 1, startDate: '2026-11-09', startAt: '09:00', pace: 'moderate',
    stops: [stop('a', '博物馆', 30.25, 120.15, { openTime: '周一闭馆 09:00-17:00' })],
    travelMinutes: async () => 0,
  });
  assert.ok(closed.issues.some((item) => item.includes('周一闭馆')));

  const full = await planDay({
    dayIndex: 1, startDate: '2026-11-09', startAt: '09:00', pace: 'tight',
    stops: Array.from({ length: 9 }, (_, index) => stop(`s${index}`, `景点${index}`)),
    travelMinutes: async () => 60,
  });
  assert.ok(full.issues.some((item) => item.includes('晚于 21:30')));
});

test('停留时长：景点按节奏，美食固定', () => {
  assert.equal(dwellMinutes(stop('a', 'A'), 'relaxed'), 90);
  assert.equal(dwellMinutes(stop('a', 'A'), 'tight'), 60);
  assert.equal(dwellMinutes(stop('a', 'A', 30, 120, { category: '美食' }), 'relaxed'), 60);
});

test('真实 legs 回填时刻：按实际通勤顺延，保留当天起始时间', () => {
  const activities = [
    { id: 'a', name: '岳王庙', lat: 30.2524, lng: 120.1346, category: '文化', startTime: '09:00', endTime: '' },
    { id: 'b', name: '西湖', lat: 30.2437, lng: 120.1479, category: '文化', startTime: '', endTime: '' },
  ];
  scheduleDays([{ activities, legs: [{ fromActivityId: 'a', toActivityId: 'b', durationMin: 26 }] }], 'moderate');
  assert.equal(activities[0]!.startTime, '09:00');
  assert.equal(activities[0]!.endTime, '10:15');
  assert.equal(activities[1]!.startTime, '10:41', '到达 = 离开 + 真实通勤 26 分钟');
  assert.equal(activities[1]!.endTime, '11:56');
});
