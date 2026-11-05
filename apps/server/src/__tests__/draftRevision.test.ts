import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerateForm, TransitLeg } from '@tripweaver/shared';
import { DraftTrip } from '../generation/draft';
import { buildDraftTools } from '../generation/tools/draftTools';

const form: GenerateForm = { destination: '北京', days: 2, startDate: '', budgetLevel: '舒适', totalBudget: 0, preferences: [], partySize: 2, extraNotes: '' };

function makeDraft(): DraftTrip {
  const draft = new DraftTrip(form);
  draft.setSkeleton('原行程', ['第一天', '第二天']);
  draft.addActivity(1, { name: '上午参观', placeName: '博物馆', poiId: 'museum', lat: 39.9, lng: 116.4, coordSource: 'geocoded', coordSystem: 'gcj02', sourceNotes: [{ title: '原地点来源', url: 'https://example.org/museum' }], startTime: '09:00', endTime: '11:00' });
  draft.addActivity(1, { name: '午餐｜旧街 · 京味', placeName: '旧街', startTime: '12:00', endTime: '13:00' });
  draft.addActivity(1, { name: '晚餐｜新街 · 京味', startTime: '18:00', endTime: '19:00' });
  return draft;
}

function leg(from: string, to: string): TransitLeg {
  return { fromActivityId: from, toActivityId: to, mode: 'transit', durationMin: 15, distanceM: 2000, source: 'amap' };
}

test('内部定位引用可供修订读取，但不会进入持久化 Trip', () => {
  const draft = makeDraft();
  assert.match(draft.render(), /poiId=museum/);
  assert.match(draft.render(), /定位=博物馆/);
  const saved = draft.toTrip().days[0]!.activities[0]!;
  assert.equal(saved.name, '上午参观');
  assert.equal('placeName' in saved, false);
  assert.equal('poiId' in saved, false);
  assert.equal(draft.mutableDays()[0]!.activities[0]!.placeName, '博物馆');
});

test('只改时间或描述保留 ID、已解析地点、坐标系和路线', () => {
  const draft = makeDraft();
  const day = draft.mutableDays()[0]!;
  const original = structuredClone(day.activities[0]!);
  day.legs = [leg(original.id, day.activities[1]!.id)];
  const legs = structuredClone(day.legs);
  draft.updateActivity(1, 1, { startTime: '09:30', description: '新的参观说明' });
  const updated = day.activities[0]!;
  assert.deepEqual(updated, { ...original, startTime: '09:30', description: '新的参观说明' });
  assert.deepEqual(day.legs, legs);
});

test('换地点清除旧坐标、引用、来源和相关路线，其他路线保留', () => {
  const draft = makeDraft();
  const day = draft.mutableDays()[0]!;
  const [a, b, c] = day.activities;
  day.legs = [leg(a!.id, b!.id), leg(b!.id, c!.id)];
  draft.updateActivity(1, 1, { name: '新公园' });
  const updated = day.activities[0]!;
  assert.equal(updated.id, a!.id);
  assert.deepEqual([updated.lat, updated.lng, updated.coordSource], [0, 0, 'estimated']);
  assert.equal(updated.coordSystem, undefined);
  assert.equal(updated.poiId, undefined);
  assert.equal(updated.placeName, undefined);
  assert.deepEqual(updated.sourceNotes, []);
  assert.deepEqual(day.legs, [leg(b!.id, c!.id)]);
});

test('单独更换 poiId 或定位名不会保留相互矛盾的旧引用', () => {
  const draft = makeDraft();
  draft.updateActivity(1, 1, { poiId: 'new-museum' });
  let activity = draft.mutableDays()[0]!.activities[0]!;
  assert.equal(activity.poiId, 'new-museum');
  assert.equal(activity.placeName, undefined);
  assert.equal(activity.coordSource, 'estimated');
  draft.updateActivity(1, 1, { placeName: '新片区' });
  activity = draft.mutableDays()[0]!.activities[0]!;
  assert.equal(activity.poiId, undefined);
  assert.equal(activity.placeName, '新片区');
});

test('重复建议同一住宿区域保留已解析坐标，替换区域才清除', () => {
  const draft = makeDraft();
  draft.setLodging('市中心');
  Object.assign(draft.lodging!, { lat: 39.9, lng: 116.4, coordSystem: 'gcj02' });
  const day = draft.mutableDays()[0]!;
  const activityLeg = leg(day.activities[0]!.id, day.activities[1]!.id);
  day.legs = [leg('lodging', day.activities[0]!.id), activityLeg, leg(day.activities[2]!.id, 'lodging')];
  const previousLegs = structuredClone(day.legs);
  const resolved = structuredClone(draft.lodging);
  draft.setLodging(' 市中心 ');
  assert.deepEqual(draft.lodging, resolved);
  assert.deepEqual(day.legs, previousLegs);
  assert.match(draft.render(), /住宿位置：市中心/);
  draft.setLodging('新城区');
  assert.deepEqual(draft.lodging, { name: '新城区' });
  assert.deepEqual(day.legs, [activityLeg], '住宿变更只使首尾住宿路线失效');
});

test('修订工具禁止重建骨架，跨天移动保留已有活动与定位信息', async () => {
  const draft = makeDraft();
  const tools = buildDraftTools(draft, 'revision');
  assert.equal(tools.some((tool) => tool.name === 'set_trip_skeleton'), false);
  assert.equal(buildDraftTools(draft).some((tool) => tool.name === 'set_trip_skeleton'), true);
  const original = structuredClone(draft.mutableDays()[0]!.activities[0]!);
  const move = tools.find((tool) => tool.name === 'move_activity')!;
  await move.execute('move', { fromDayIndex: 1, activityId: original.id, toDayIndex: 2 });
  assert.equal(draft.title, '原行程');
  assert.deepEqual(draft.mutableDays().map((day) => day.title), ['第一天', '第二天']);
  assert.equal(draft.mutableDays()[0]!.activities.some((activity) => activity.id === original.id), false);
  assert.deepEqual(draft.mutableDays()[1]!.activities[0], original);
  const snapshot = structuredClone(draft.mutableDays());
  await move.execute('missing', { fromDayIndex: 1, activityId: 'missing', toDayIndex: 2 });
  assert.deepEqual(draft.mutableDays(), snapshot);
});
