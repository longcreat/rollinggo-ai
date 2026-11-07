// 直播合成行程：job_start 建骨架，plan_day 逐日替换，未知天序忽略。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GenerationEvent } from '@tripweaver/shared';
import { applyPlanDay, buildLiveTrip, LIVE_TRIP_ID } from '../src/lib/liveTrip';

const start = (extra: Partial<Extract<GenerationEvent, { type: 'job_start' }>> = {}): GenerationEvent => ({
  type: 'job_start', destination: '杭州', days: 2, startDate: '2026-11-15', xhsEnabled: true, dataSources: ['amap'], ...extra,
});
const day = (dayIndex: number, names: string[], title?: string): GenerationEvent => ({
  type: 'plan_day', dayIndex, ...(title ? { title } : {}),
  stops: names.map((name, index) => ({
    name, lat: 30.25 + index * 0.001, lng: 120.15 + index * 0.001,
    startTime: `09:0${index}`, endTime: `10:0${index}`, category: '文化' as const,
  })),
});

test('没有 job_start 时返回 null', () => {
  assert.equal(buildLiveTrip([day(1, ['断桥'])]), null);
});

test('job_start 建立空天，plan_day 填充坐标与时刻', () => {
  const trip = buildLiveTrip([start(), day(1, ['断桥残雪', '白堤'])])!;
  assert.equal(trip.id, LIVE_TRIP_ID);
  assert.equal(trip.destination, '杭州');
  assert.equal(trip.startDate, '2026-11-15');
  assert.equal(trip.days.length, 2);
  assert.equal(trip.days[0]!.activities.length, 2);
  assert.equal(trip.days[1]!.activities.length, 0);
  const first = trip.days[0]!.activities[0]!;
  assert.equal(first.id, 'live-1-0');
  assert.equal(first.startTime, '09:00');
  assert.equal(first.coordSource, 'geocoded');
  assert.equal(first.coordSystem, 'gcj02');
});

test('同一天再次 plan_day 整体替换，活动 id 保持可预测', () => {
  const first = buildLiveTrip([start(), day(1, ['A', 'B', 'C'])])!;
  const next = applyPlanDay(first, day(1, ['B', 'C']) as Extract<GenerationEvent, { type: 'plan_day' }>);
  assert.deepEqual(next.days[0]!.activities.map((item) => item.id), ['live-1-0', 'live-1-1']);
  assert.deepEqual(next.days[0]!.activities.map((item) => item.name), ['B', 'C']);
});

test('未知天序与缺 days 的旧事件', () => {
  const trip = buildLiveTrip([start({ days: undefined }), day(2, ['越界'])])!;
  assert.equal(trip.days.length, 1);
  assert.equal(trip.days[0]!.activities.length, 0, '超出骨架的天数被忽略');
});

test('标题随 plan_day 回填', () => {
  const trip = buildLiveTrip([start(), day(1, ['断桥'], '西湖初览')])!;
  assert.equal(trip.days[0]!.title, '西湖初览');
});
