// 单测：对话按需编辑的归一与应用（纯函数，见 chat/editOps.ts）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ItineraryEditOpsSchema, EditOpOutcomeSchema, MAX_TRIP_DAYS, TripSchema, briefToGenerateForm, makeSampleTrip, type Trip } from '@tripweaver/shared';
import { Value } from '@sinclair/typebox/value';
import { applyItineraryEdits, editActivityDrafts, normalizeEditOps } from '../chat/editOps';
import { syncBriefTripDates } from '../chat/brief';

function trip(): Trip {
  const t = makeSampleTrip();
  // 给第 1 天挂两条 leg，验证删除/替换后的清理
  const [a, b, c] = t.days[0]!.activities;
  if (a && b && c) {
    t.days[0]!.legs = [
      { fromActivityId: a.id, toActivityId: b.id, mode: 'walk', durationMin: 10, distanceM: 800, source: 'heuristic' },
      { fromActivityId: b.id, toActivityId: c.id, mode: 'walk', durationMin: 12, distanceM: 900, source: 'heuristic' },
    ];
  }
  return t;
}

test('normalizeEditOps：非数组/越界/缺字段的条目被丢弃，合法条目保留', () => {
  assert.deepEqual(normalizeEditOps(null), []);
  assert.deepEqual(normalizeEditOps([{ kind: 'delete_activity', dayIndex: 0, activityId: 'x' }]), []);   // dayIndex 从 1 起
  assert.deepEqual(normalizeEditOps([{ kind: 'replace_activity', dayIndex: 1, activityId: 'x' }]), []);     // 缺 activity
  const ops = normalizeEditOps([
    { kind: 'add_activity', dayIndex: 2, activity: { name: '夜市', category: '美食' } },
    { kind: 'add_activity', dayIndex: 2, activity: { name: '  ' } },                                       // 空名丢弃
    { kind: 'nonsense', dayIndex: 1 },
  ]);
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.kind, 'add_activity');
});

test('replace_activity：原位替换，旧活动的 leg 全部清除，其余不动', () => {
  const t = trip();
  const day1 = t.days[0]!;
  const victim = day1.activities[1]!;
  const result = applyItineraryEdits(t, [
    { kind: 'replace_activity', dayIndex: 1, activityId: victim.id, activity: { name: '上海博物馆', category: '文化', lat: 31.23, lng: 121.47 } },
  ]);
  assert.equal(result.changed, true);
  const nextDay = result.trip.days[0]!;
  assert.equal(nextDay.activities.length, day1.activities.length);           // 数量不变
  assert.equal(nextDay.activities[1]!.name, '上海博物馆');                   // 原位
  assert.equal(nextDay.activities[1]!.coordSource, 'geocoded');
  assert.equal(nextDay.activities[1]!.startTime, '');                        // 时刻轴恒空（D5）
  assert.deepEqual(nextDay.legs, []);                                        // 两条 leg 都触及被替换活动
  assert.notEqual(nextDay.activities[1]!.id, victim.id);                     // 新 id
});

test('delete_activity：移除目标，只清触及它的 leg', () => {
  const t = trip();
  const day1 = t.days[0]!;
  const [a, b, c] = day1.activities;
  void a; void c;
  const result = applyItineraryEdits(t, [{ kind: 'delete_activity', dayIndex: 1, activityId: b!.id }]);
  assert.equal(result.changed, true);
  const nextDay = result.trip.days[0]!;
  assert.deepEqual(nextDay.activities.map((x) => x.id), day1.activities.filter((x) => x.id !== b!.id).map((x) => x.id));
  assert.deepEqual(nextDay.legs, []);   // a→b 与 b→c 都触及 b
});

test('add_activity：默认追加到末尾，position 越界截断', () => {
  const t = trip();
  const count = t.days[1]!.activities.length;
  const append = applyItineraryEdits(t, [{ kind: 'add_activity', dayIndex: 2, activity: { name: '田子坊' } }]);
  assert.equal(append.trip.days[1]!.activities.length, count + 1);
  assert.equal(append.trip.days[1]!.activities.at(-1)!.name, '田子坊');

  const insert = applyItineraryEdits(t, [{ kind: 'add_activity', dayIndex: 2, position: 0, activity: { name: '外滩日出' } }]);
  assert.equal(insert.trip.days[1]!.activities[0]!.name, '外滩日出');
});

test('定位失败的操作被拒绝但不影响其他条；全拒绝时 changed=false', () => {
  const t = trip();
  const keep = t.days[0]!.activities[0]!;
  const result = applyItineraryEdits(t, [
    { kind: 'delete_activity', dayIndex: 99, activityId: 'ghost' },          // 天不存在
    { kind: 'delete_activity', dayIndex: 1, activityId: keep.id },
  ]);
  assert.equal(result.changed, true);
  assert.equal(result.outcomes[0]!.applied, false);
  assert.equal(result.outcomes[1]!.applied, true);

  const noop = applyItineraryEdits(t, [{ kind: 'delete_activity', dayIndex: 1, activityId: 'ghost' }]);
  assert.equal(noop.changed, false);
  assert.equal(noop.trip.days[0]!.activities.length, t.days[0]!.activities.length);
});

test('同一活动被两条操作命中时只执行第一条', () => {
  const t = trip();
  const victim = t.days[0]!.activities[0]!;
  const result = applyItineraryEdits(t, [
    { kind: 'replace_activity', dayIndex: 1, activityId: victim.id, activity: { name: '新活动' } },
    { kind: 'delete_activity', dayIndex: 1, activityId: victim.id },
  ]);
  assert.equal(result.outcomes[0]!.applied, true);
  assert.equal(result.outcomes[1]!.applied, false);
  assert.equal(result.trip.days[0]!.activities.length, t.days[0]!.activities.length);
});

test('不修改传入的原行程对象（immutable）', () => {
  const t = trip();
  const before = structuredClone(t);
  applyItineraryEdits(t, [{ kind: 'delete_activity', dayIndex: 1, activityId: t.days[0]!.activities[0]!.id }]);
  assert.deepEqual(t, before);
});

test('add_days：整组追加多个日期和活动，保留旧日期，坐标草稿进入解析列表', () => {
  const current = trip();
  const before = structuredClone(current);
  const firstIndex = current.days.length + 1;
  const raw = [{ kind: 'add_days', dayIndex: firstIndex, days: [
    { title: '城市慢游', activities: [{ name: '上海博物馆', category: '文化' }] },
    { title: '自由休息', activities: [] },
  ] }];
  assert.equal(Value.Check(ItineraryEditOpsSchema, raw), true);
  const ops = normalizeEditOps(raw);
  const drafts = editActivityDrafts(ops);
  assert.equal(drafts.length, 1);
  Object.assign(drafts[0]!, { lat: 31.23, lng: 121.47 });
  const result = applyItineraryEdits(current, ops);
  assert.equal(result.changed, true);
  assert.equal(result.trip.days.length, current.days.length + 2);
  assert.deepEqual(result.trip.days.slice(0, current.days.length), current.days);
  assert.deepEqual(current, before);
  assert.deepEqual(result.trip.days.slice(-2).map((day) => day.dayIndex), [firstIndex, firstIndex + 1]);
  assert.equal(result.trip.days.at(-2)!.activities[0]!.coordSource, 'geocoded');
  assert.equal(new Set(result.trip.days.map((day) => day.id)).size, result.trip.days.length);
  assert.equal(Value.Check(TripSchema, result.trip), true);
  assert.equal(Value.Check(EditOpOutcomeSchema, result.outcomes[0]), true);
});

test('add_days：不跳号、不覆盖已有日期、不重复追加、不部分接受超限天数', () => {
  const current = trip();
  const days = [{ title: '新增日期', activities: [] }];
  for (const dayIndex of [1, current.days.length + 2]) {
    const result = applyItineraryEdits(current, [{ kind: 'add_days', dayIndex, days }]);
    assert.equal(result.changed, false);
    assert.deepEqual(result.trip.days, current.days);
  }
  const tooMany = applyItineraryEdits(current, [{ kind: 'add_days', dayIndex: current.days.length + 1, days: Array.from({ length: MAX_TRIP_DAYS }, () => days[0]!) }]);
  assert.equal(tooMany.changed, false);
  assert.match(tooMany.outcomes[0]!.summary, /最多支持 15 天/);
  const duplicate = applyItineraryEdits(current, [
    { kind: 'add_days', dayIndex: current.days.length + 1, days },
    { kind: 'add_days', dayIndex: current.days.length + 2, days },
  ]);
  assert.equal(duplicate.trip.days.length, current.days.length + 1);
  assert.equal(duplicate.outcomes[1]!.applied, false);
});

test('add_days：非法日期组整组拒绝，明确空白日期允许', () => {
  const validDay = { title: '有效日期', activities: [{ name: '公园' }] };
  for (const days of [[], [validDay, { title: '坏数据', activities: [{ name: '  ' }] }], [validDay, { title: '坏数据' }], [{ title: '太满', activities: Array.from({ length: 13 }, () => ({ name: '公园' })) }]]) {
    assert.deepEqual(normalizeEditOps([{ kind: 'add_days', dayIndex: 4, days }]), []);
  }
  assert.equal(normalizeEditOps([{ kind: 'add_days', dayIndex: 4, days: [{ title: '休息日', activities: [] }] }]).length, 1);
});

test('日期同步：新增天数跨月并更新旧结束日期，恢复短行程后重新生成不沿用长天数', () => {
  const current = trip(); current.startDate = '2026-12-31'; current.days = current.days.slice(0, 2);
  const next = syncBriefTripDates({ constraints: [], days: 10, startDate: '2026-12-20', endDate: '2026-12-29' }, current);
  assert.equal(next.endDate, '2027-01-01');
  assert.equal(briefToGenerateForm(next).days, 2);
  const noDate = syncBriefTripDates(next, { ...current, startDate: '' });
  assert.equal(noDate.endDate, undefined);
  assert.equal(noDate.days, 2);
});
