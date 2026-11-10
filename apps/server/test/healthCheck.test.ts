// 行程体检核心测试：审计规则命中 + Pass 2 重排纪律（hard 递减、恶化回滚）。
// 纯内存数据，不碰 DB 与网络。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { simulateTrip, type Activity, type Trip, type HealthFinding } from '@rollinggo-trip/shared';
import { auditTrip } from '@rollinggo-trip/services/healthAudit';
import { applyHealthDecisions } from '@rollinggo-trip/services/healthRepairService';

function activity(id: string, name: string, over: Partial<Activity> = {}) {
  return {
    id, name, startTime: '', endTime: '', description: '',
    lat: 30.66, lng: 104.06, coordSource: 'geocoded' as const, coordSystem: 'gcj02' as const,
    category: '文化' as const, sourceNotes: [], ...over,
  };
}

function trip(days: Trip['days'], over: Partial<Trip> = {}): Trip {
  return {
    id: 't1', title: '测试行程', destination: '成都', startDate: '2026-12-01',
    budgetLevel: '舒适', totalBudget: 0, preferences: [], partySize: 2, extraNotes: '',
    transportMode: 'transit',
    days, meta: { usedXhs: false, reviewNotes: [] }, createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('auditTrip（Pass 1a 确定性审计）', () => {
  it('健康的行程：零 findings', () => {
    const result = auditTrip(trip([{
      id: 'd1', dayIndex: 1, title: '轻松一天',
      activities: [
        activity('a1', '人民公园', { startTime: '09:00', endTime: '11:00' }),
        activity('a2', '宽窄巷子', { startTime: '14:00', endTime: '16:00', lat: 30.67, lng: 104.05 }),
      ],
      legs: [],
    }]));
    assert.equal(result.findings.length, 0);
  });

  it('单日超载：报 hard overpacked，建议挪最末活动到最空闲天', () => {
    // 6 个长活动 × 2.5h = 15h > 14h → hard overpacked
    const activities = Array.from({ length: 6 }, (_, i) =>
      activity(`a${i}`, `景点${i}`, { startTime: '09:00', endTime: '11:30' }));
    const result = auditTrip(trip([
      { id: 'd1', dayIndex: 1, title: '特种兵', activities, legs: [] },
      { id: 'd2', dayIndex: 2, title: '空闲', activities: [activity('b1', '轻松点')], legs: [] },
    ]));
    const overpacked = result.findings.find((f) => f.code === 'overpacked' && f.severity === 'hard');
    assert.ok(overpacked, '应报 hard overpacked');
    assert.equal(overpacked.suggestion.kind, 'move_activity');
    assert.equal(overpacked.suggestion.toDayIndex, 2, '建议挪到活动最少的第 2 天');
    assert.ok(overpacked.suggestion.summary.includes('挪到第 2 天'));
  });

  it('闭馆日：报 hard closed_on_arrival，建议删除', () => {
    // 2026-12-07 是周一；营业时间声明周一闭馆
    const result = auditTrip(trip([{
      id: 'd1', dayIndex: 1, title: '周一出行',
      activities: [activity('a1', '博物馆', {
        startTime: '09:00', endTime: '11:00',
        openTime: '周一闭馆 逢周一闭馆',
      })],
      legs: [],
    }], { startDate: '2026-12-07' }));
    const closed = result.findings.find((f) => f.code === 'closed_on_arrival');
    assert.ok(closed, '应报 closed_on_arrival');
    assert.equal(closed.severity, 'hard');
    assert.equal(closed.suggestion.kind, 'delete_activity');
    assert.equal(closed.suggestion.activityId, 'a1');
  });

  it('hard 排在 soft 前面', () => {
    const activities = Array.from({ length: 9 }, (_, i) => activity(`a${i}`, `点${i}`));  // 9 > 8 → soft overpacked
    activities[0] = { ...activities[0]!, startTime: '08:00', endTime: '20:00' };           // 12h 单活动 + 其余 → hard? 只有 12h
    activities.push(activity('a9', '压死骆驼', { startTime: '20:30', endTime: '21:00' }));
    const result = auditTrip(trip([
      { id: 'd1', dayIndex: 1, title: '混杂', activities, legs: [] },
    ]));
    const hardFirst = result.findings.findIndex((f) => f.severity === 'soft') >= result.findings.findIndex((f) => f.severity === 'hard');
    assert.ok(hardFirst, 'hard 应排在 soft 前');
  });
});

describe('applyHealthDecisions（Pass 2 重排纪律）', () => {
  const finding = (over: Partial<HealthFinding>): HealthFinding => ({
    id: 'f1', code: 'overpacked', severity: 'hard', dayIndex: 1,
    message: '测试', suggestion: { kind: 'move_activity', summary: '挪走' }, ...over,
  });

  it('accept 一个有效建议：hard 递减 → 应用并返回摘要', async () => {
    // 第 1 天 hard 超载；挪一个活动到第 2 天后 hard 消除
    const activities = Array.from({ length: 6 }, (_, i) =>
      activity(`a${i}`, `景点${i}`, { startTime: '09:00', endTime: '11:30' }));
    const target = trip([
      { id: 'd1', dayIndex: 1, title: '超载', activities, legs: [] },
      { id: 'd2', dayIndex: 2, title: '空闲', activities: [activity('b1', '轻松')], legs: [] },
    ]);
    const decisions = [{ findingId: 'f1', action: 'accept' as const }];
    const outcome = await applyHealthDecisions(target, [
      finding({ suggestion: { kind: 'move_activity', activityId: 'a5', toDayIndex: 2, summary: '挪 a5 到第 2 天' } }),
    ], decisions, AbortSignal.timeout(5_000));

    assert.ok(outcome, '应产出重排结果');
    assert.equal(outcome.applied.length, 1);
    const day2 = outcome.trip.days.find((d) => d.dayIndex === 2)!;
    assert.ok(day2.activities.some((a) => a.id === 'a5'), 'a5 应挪到第 2 天');
    for (const moved of day2.activities) {
      assert.match(moved.startTime, /^\d{2}:\d{2}$/, '被挪活动重排后有时刻，不留裸活动');
      assert.match(moved.endTime, /^\d{2}:\d{2}$/);
    }
    const day1 = outcome.trip.days.find((d) => d.dayIndex === 1)!;
    assert.ok(!day1.activities.some((a) => a.id === 'a5'), 'a5 应离开第 1 天');
    for (const kept of day1.activities) {
      assert.match(kept.startTime, /^\d{2}:\d{2}$/, '留下的活动也按通勤与餐窗重排');
    }
    assert.equal(day1.activities[0]!.startTime, '09:00', '原行程对象不被修改');
  });

  it('错误建议（删了不相关的活动）不减少 hard → 回滚，行程不变', async () => {
    // d1 的唯一 hard 是闭馆(a1，重排救不了)；时刻本身可行。建议却删 a4（无关活动）——
    // 删除 + 时刻重排后 hard 不减，应回滚
    const target = trip([
      { id: 'd1', dayIndex: 1, title: '问题日',
        activities: [
          activity('a1', '博物馆', { startTime: '09:00', endTime: '10:00', openTime: '周一闭馆' }),
          activity('a2', '公园', { startTime: '10:10', endTime: '11:00' }),
          activity('a3', '展馆', { startTime: '11:30', endTime: '12:30', lat: 30.67, lng: 104.05 }),
          activity('a4', '咖啡', { startTime: '14:00', endTime: '15:00' }),
        ], legs: [] },
    ], { startDate: '2026-12-07' });
    const before = simulateTrip(target).violations.filter((v) => v.severity === 'hard').length;
    assert.ok(before >= 1, `场景前提：至少 1 个 hard，实际 ${before}`);
    const outcome = await applyHealthDecisions(target, [
      finding({ suggestion: { kind: 'delete_activity', activityId: 'a4', summary: '删除无关的咖啡' } }),
    ], [{ findingId: 'f1', action: 'accept' as const }], AbortSignal.timeout(5_000));
    assert.equal(outcome, null, `删除无关活动不减少 hard（${before} 个）应回滚`);
    assert.equal(target.days[0]!.activities.length, 4, '原行程未被改动');
  });

  it('skip / self_handle 不动行程；无 accept 返回 null', async () => {
    const target = trip([{ id: 'd1', dayIndex: 1, title: '一天', activities: [activity('a1', '点')], legs: [] }]);
    const outcome = await applyHealthDecisions(target, [
      finding({ suggestion: { kind: 'delete_activity', activityId: 'a1', summary: '删除' } }),
    ], [
      { findingId: 'f1', action: 'self_handle' as const, comment: '已预约' },
      { findingId: 'f-notexist', action: 'skip' as const },
    ], AbortSignal.timeout(5_000));
    assert.equal(outcome, null);
    assert.equal(target.days[0]!.activities.length, 1, '行程未被改动');
  });

  it('删除闭馆活动：hard 消除 → 应用', async () => {
    const target = trip([
      { id: 'd1', dayIndex: 1, title: '周一',
        activities: [
          activity('a1', '博物馆', { startTime: '09:00', endTime: '11:00', openTime: '周一闭馆' }),
          activity('a2', '公园', { startTime: '13:00', endTime: '15:00', lat: 30.67, lng: 104.05 }),
        ], legs: [] },
    ], { startDate: '2026-12-07' });
    const outcome = await applyHealthDecisions(target, [
      finding({ code: 'closed_on_arrival', suggestion: { kind: 'delete_activity', activityId: 'a1', summary: '删除闭馆的博物馆' } }),
    ], [{ findingId: 'f1', action: 'accept' as const }], AbortSignal.timeout(5_000));
    assert.ok(outcome, '删闭馆活动应成功');
    assert.ok(!outcome.trip.days[0]!.activities.some((a) => a.id === 'a1'));
    const kept = outcome.trip.days[0]!.activities[0]!;
    assert.match(kept.startTime, /^\d{2}:\d{2}$/, '删除后当天剩余活动重排仍有时刻');
  });
});
