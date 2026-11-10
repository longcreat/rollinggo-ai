// 单测：schema 增量兼容——旧行程 JSON（无 coordSystem/legs/transportMode/lodging，cost 带值）原样可读，新字段可选通过
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Value } from '@sinclair/typebox/value';
import { ActivitySchema, GenerateFormSchema, LodgingSchema, TransitLegSchema, TripDaySchema } from '@tripweaver/shared';

const oldActivity = {
  id: 'a1',
  name: '外滩',
  startTime: '09:00',
  endTime: '11:00',
  description: '',
  lat: 31.24,
  lng: 121.49,
  coordSource: 'geocoded',
  cost: 0,
  category: '文化',
  sourceNotes: [],
};

test('旧 Activity（无 coordSystem）仍通过校验', () => {
  assert.ok(Value.Check(ActivitySchema, oldActivity));
});

test('新 Activity（coordSystem=gcj02）通过校验；非法坐标系拒绝', () => {
  assert.ok(Value.Check(ActivitySchema, { ...oldActivity, coordSystem: 'gcj02' }));
  assert.ok(!Value.Check(ActivitySchema, { ...oldActivity, coordSystem: 'bd09' }));
});

test('旧 TripDay（无 legs）与新 TripDay（含 legs）均通过校验', () => {
  const oldDay = { id: 'd1', dayIndex: 1, title: '第一天', activities: [oldActivity] };
  assert.ok(Value.Check(TripDaySchema, oldDay));
  const leg = { fromActivityId: 'a1', toActivityId: 'a2', mode: 'walk', durationMin: 12, distanceM: 800, source: 'heuristic' };
  assert.ok(Value.Check(TransitLegSchema, leg));
  assert.ok(Value.Check(TripDaySchema, { ...oldDay, legs: [leg, { ...leg, source: 'amap', polyline: '116.1,39.1;116.2,39.2' }] }));
  assert.ok(!Value.Check(TransitLegSchema, { ...leg, mode: 'fly' }));
});

test('ST3：cost 可选化——旧数据带值照读，新数据缺省通过，负值拒绝', () => {
  const { cost: _drop, ...noCost } = oldActivity;
  assert.ok(Value.Check(ActivitySchema, noCost));
  assert.ok(!Value.Check(ActivitySchema, { ...oldActivity, cost: -1 }));
});

test('ST3：lodging / transportMode 可选字段与哨兵 leg 契约', () => {
  assert.ok(Value.Check(LodgingSchema, { name: '西湖景区周边' }));
  assert.ok(Value.Check(LodgingSchema, { name: '某酒店', area: '西湖区', lat: 30.2, lng: 120.1, coordSystem: 'gcj02' }));
  assert.ok(!Value.Check(LodgingSchema, { name: '' }));
  // 哨兵 id 'lodging' 本就是合法 string，schema 层无需特判
  assert.ok(Value.Check(TransitLegSchema, { fromActivityId: 'lodging', toActivityId: 'a1', mode: 'transit', durationMin: 20, distanceM: 5000, source: 'heuristic' }));
  const dayWithLodging = { id: 'd1', dayIndex: 1, title: '', activities: [oldActivity], lodging: { name: '新宿站附近' } };
  assert.ok(Value.Check(TripDaySchema, dayWithLodging));
  const form = { destination: '杭州', days: 3, startDate: '', budgetLevel: '舒适', totalBudget: 0, preferences: [], partySize: 2, extraNotes: '' };
  assert.ok(Value.Check(GenerateFormSchema, form));   // 旧表单（无新字段）兼容
  assert.ok(Value.Check(GenerateFormSchema, { ...form, transportMode: 'drive', lodging: '西湖景区周边' }));
  assert.ok(!Value.Check(GenerateFormSchema, { ...form, transportMode: 'fly' }));
});
