// 行程草稿写操作的契约：边界、拒绝原因、通勤段失效、快照隔离。
// 无需数据库与环境变量：这一层刻意做成纯函数，便于把「模型能怎么改行程」钉死在测试里。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Trip } from '@tripweaver/shared';
import { createTripDraft } from '../chat/agent/tripDraft';

function baseTrip(): Trip {
  return {
    id: 't1', title: '成都三日', destination: '成都', startDate: '2026-11-10',
    budgetLevel: '舒适', totalBudget: 3000, preferences: ['美食'], partySize: 2,
    extraNotes: '带老人，节奏慢一点', transportMode: 'transit',
    lodging: { name: '春熙路某酒店', lat: 30.65, lng: 104.08, coordSystem: 'gcj02' },
    days: [
      {
        id: 'd1', dayIndex: 1, title: '市区漫步',
        activities: [
          { id: 'a1', name: '人民公园', startTime: '09:00', endTime: '11:00', description: '喝茶', lat: 30.66, lng: 104.06, coordSource: 'geocoded', coordSystem: 'gcj02', category: '自然', sourceNotes: [] },
          { id: 'a2', name: '宽窄巷子', startTime: '', endTime: '', description: '', lat: 30.67, lng: 104.05, coordSource: 'geocoded', coordSystem: 'gcj02', category: '文化', sourceNotes: [] },
        ],
        legs: [{ fromActivityId: 'a1', toActivityId: 'a2', mode: 'walk', durationMin: 12, distanceM: 800, source: 'heuristic' }],
      },
      {
        id: 'd2', dayIndex: 2, title: '博物馆日',
        activities: [{ id: 'b1', name: '四川博物院', startTime: '', endTime: '', description: '', lat: 30.66, lng: 104.03, coordSource: 'geocoded', coordSystem: 'gcj02', category: '文化', sourceNotes: [] }],
        legs: [],
      },
    ],
    meta: { usedXhs: false, reviewNotes: [] },
    createdAt: 1, updatedAt: 1,
  };
}

describe('add_activity', () => {
  it('带坐标新增，标记 geocoded，并清空当天旧通勤段', () => {
    const draft = createTripDraft(baseTrip());
    const result = draft.addActivity({ dayIndex: 1, name: '鹤鸣茶社', category: '美食', lat: 30.661, lng: 104.061, cost: 40 });
    assert.equal(result.outcome.applied, true);
    assert.match(result.outcome.summary, /新增「鹤鸣茶社」/);
    const trip = draft.current();
    const day = trip.days[0]!;
    assert.equal(day.activities.length, 3);
    assert.equal(day.activities[2]!.coordSource, 'geocoded');
    assert.equal(day.activities[2]!.cost, 40);
    assert.deepEqual(day.legs, [], '结构变化后旧动线必须失效，交给 repairChangedRoutes 重算');
    assert.equal(draft.changed(), true);
  });

  it('无坐标时按 estimated 落库，不伪造位置', () => {
    const draft = createTripDraft(baseTrip());
    draft.addActivity({ dayIndex: 2, name: '某不知名小馆' });
    const added = draft.current().days[1]!.activities.at(-1)!;
    assert.equal(added.coordSource, 'estimated');
    assert.equal(added.lat, 0);
  });

  it('重复地点拒绝，明确要求重访才允许', () => {
    const draft = createTripDraft(baseTrip());
    const rejected = draft.addActivity({ dayIndex: 2, name: '人民公园' });
    assert.equal(rejected.outcome.applied, false);
    assert.match(rejected.outcome.summary, /已在行程中/);
    const allowed = draft.addActivity({ dayIndex: 2, name: '人民公园', allowRevisit: true });
    assert.equal(allowed.outcome.applied, true);
  });

  it('每天活动数到达上限后拒绝', () => {
    const trip = baseTrip();
    for (let i = 0; i < 12; i++) {
      trip.days[1]!.activities.push({ id: `x${i}`, name: `点 ${i}`, startTime: '', endTime: '', description: '', lat: 0, lng: 0, coordSource: 'estimated', category: '其他', sourceNotes: [] });
    }
    const draft = createTripDraft(trip);
    const result = draft.addActivity({ dayIndex: 2, name: '再来一个' });
    assert.equal(result.outcome.applied, false);
    assert.match(result.outcome.summary, /上限/);
  });

  it('按 afterActivityId 插入到目标活动之后', () => {
    const draft = createTripDraft(baseTrip());
    const result = draft.addActivity({ dayIndex: 1, name: '文殊院', afterActivityId: 'a1', lat: 30.68, lng: 104.07 });
    assert.equal(result.outcome.applied, true);
    assert.deepEqual(draft.current().days[0]!.activities.map((item) => item.name), ['人民公园', '文殊院', '宽窄巷子']);
  });

  it('afterActivityId 不存在时拒绝，不猜位置', () => {
    const draft = createTripDraft(baseTrip());
    const result = draft.addActivity({ dayIndex: 1, name: '文殊院', afterActivityId: 'nope' });
    assert.equal(result.outcome.applied, false);
    assert.match(result.outcome.summary, /没有活动 id/);
    assert.equal(draft.changed(), false);
  });

  it('回归：茶馆插在博物馆之后，时刻按新顺序派生而不是倒序', () => {
    const trip = baseTrip();
    const activity = (id: string, name: string, startTime: string, endTime: string) => ({
      id, name, startTime, endTime, description: '', lat: 30.67, lng: 104.06,
      coordSource: 'geocoded' as const, coordSystem: 'gcj02' as const, category: '文化' as const, sourceNotes: [],
    });
    trip.days[0] = {
      id: 'd1', dayIndex: 1, title: '古院老巷',
      activities: [
        activity('fan', '制扇至美博物馆', '14:13', '15:43'),
        activity('museum', '成都画院', '15:50', '17:15'),
        activity('wide', '宽窄巷子', '17:22', '18:52'),
      ],
      legs: [],
    };
    const draft = createTripDraft(trip, { pace: 'moderate' });
    const result = draft.addActivity({
      dayIndex: 1, name: '鲁班茶肆', category: '美食', afterActivityId: 'museum', durationMin: 80,
      lat: 30.6691, lng: 104.0553,
    });
    assert.equal(result.outcome.applied, true);
    const day = draft.current().days[0]!;
    assert.deepEqual(day.activities.map((item) => item.name), ['制扇至美博物馆', '成都画院', '鲁班茶肆', '宽窄巷子']);
    const minutes = (value: string) => {
      const parts = value.split(':').map(Number);
      return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
    };
    for (let index = 1; index < day.activities.length; index += 1) {
      assert.ok(minutes(day.activities[index]!.startTime) >= minutes(day.activities[index - 1]!.endTime));
    }
    const tea = day.activities[2]!;
    assert.equal(minutes(tea.endTime) - minutes(tea.startTime), 80);
  });

  it('新增后按顺序派生时刻，时间线不倒退', () => {
    const draft = createTripDraft(baseTrip());
    draft.addActivity({ dayIndex: 1, name: '文殊院', afterActivityId: 'a2', durationMin: 60, lat: 30.68, lng: 104.07 });
    const activities = draft.current().days[0]!.activities;
    const minutes = (value: string) => {
      const parts = value.split(':').map(Number);
      return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
    };
    for (let index = 1; index < activities.length; index += 1) {
      assert.ok(minutes(activities[index]!.startTime) >= minutes(activities[index - 1]!.endTime), '后一项不能早于前一项结束');
    }
    assert.equal(minutes(activities[2]!.endTime) - minutes(activities[2]!.startTime), 60, '显式停留时长生效');
  });
});

describe('update_activity', () => {
  it('只改传入字段，名称冲突拒绝', () => {
    const draft = createTripDraft(baseTrip());
    const ok = draft.updateActivity({ dayIndex: 1, activityId: 'a2', description: '晚上来更热闹', cost: 0 });
    assert.equal(ok.outcome.applied, true);
    assert.match(ok.outcome.summary, /简介已更新/);
    const target = draft.current().days[0]!.activities[1]!;
    assert.equal(target.description, '晚上来更热闹');
    assert.equal(target.cost, 0);

    const conflict = draft.updateActivity({ dayIndex: 1, activityId: 'a2', name: '人民公园' });
    assert.equal(conflict.outcome.applied, false);
    assert.match(conflict.outcome.summary, /已有「人民公园」/);
  });

  it('停留时长写回并立即重排，后续活动顺延', () => {
    const draft = createTripDraft(baseTrip());
    const before = draft.current().days[0]!.activities[1]!.startTime;
    const result = draft.updateActivity({ dayIndex: 1, activityId: 'a1', durationMin: 150 });
    assert.equal(result.outcome.applied, true);
    assert.equal(draft.current().days[0]!.activities[0]!.durationMin, 150);
    assert.notEqual(draft.current().days[0]!.activities[1]!.startTime, before, '前一项变长后，后一项必须顺延');
  });

  it('找不到 id 时拒绝并提示先读当天', () => {
    const draft = createTripDraft(baseTrip());
    const result = draft.updateActivity({ dayIndex: 1, activityId: 'nope', name: 'x' });
    assert.equal(result.outcome.applied, false);
    assert.match(result.outcome.summary, /get_day/);
  });

  it('改名视为换了地点：旧坐标失效、当天动线清空', () => {
    const draft = createTripDraft(baseTrip());
    const result = draft.updateActivity({ dayIndex: 1, activityId: 'a1', name: '成都博物馆' });
    assert.equal(result.outcome.applied, true);
    const target = draft.current().days[0]!.activities[0]!;
    assert.equal(target.name, '成都博物馆');
    assert.equal(target.coordSource, 'estimated', '不能沿用原地点坐标冒充已定位');
    assert.deepEqual([target.lat, target.lng], [0, 0]);
    assert.deepEqual(draft.current().days[0]!.legs, []);
  });

  it('改名同时给出新坐标时按 geocoded 落库', () => {
    const draft = createTripDraft(baseTrip());
    draft.updateActivity({ dayIndex: 1, activityId: 'a1', name: '成都博物馆', lat: 30.6572, lng: 104.063 });
    const target = draft.current().days[0]!.activities[0]!;
    assert.equal(target.coordSource, 'geocoded');
    assert.equal(target.coordSystem, 'gcj02');
    assert.deepEqual([target.lat, target.lng], [30.6572, 104.063]);
  });

  it('只改简介不影响坐标与动线', () => {
    const draft = createTripDraft(baseTrip());
    draft.updateActivity({ dayIndex: 1, activityId: 'a1', description: '早上去人少' });
    const day = draft.current().days[0]!;
    assert.equal(day.activities[0]!.coordSource, 'geocoded');
    assert.equal(day.legs?.length, 1);
  });

  it('没有任何可应用变化时拒绝', () => {
    const draft = createTripDraft(baseTrip());
    const result = draft.updateActivity({ dayIndex: 1, activityId: 'a1', name: '人民公园' });
    assert.equal(result.outcome.applied, false);
    assert.equal(draft.changed(), false);
  });
});

describe('delete / move / reorder', () => {
  it('删除活动并清空当天通勤段', () => {
    const draft = createTripDraft(baseTrip());
    const result = draft.deleteActivity(1, 'a1');
    assert.equal(result.outcome.applied, true);
    assert.equal(draft.current().days[0]!.activities.length, 1);
    assert.deepEqual(draft.current().days[0]!.legs, []);
  });

  it('跨天移动会同时清空两天的通勤段', () => {
    const draft = createTripDraft(baseTrip());
    const result = draft.moveActivity(1, 'a2', 2);
    assert.equal(result.outcome.applied, true);
    assert.deepEqual(draft.current().days[0]!.activities.map((a) => a.name), ['人民公园']);
    assert.deepEqual(draft.current().days[1]!.activities.map((a) => a.name), ['四川博物院', '宽窄巷子']);
    assert.deepEqual(draft.current().days[0]!.legs, []);
  });

  it('同一天内挪动引导去 reorder_day', () => {
    const draft = createTripDraft(baseTrip());
    const result = draft.moveActivity(1, 'a1', 1);
    assert.equal(result.outcome.applied, false);
    assert.match(result.outcome.summary, /reorder_day/);
  });

  it('重排必须给出当天全部 id 的排列', () => {
    const draft = createTripDraft(baseTrip());
    const bad = draft.reorderDay(1, ['a2']);
    assert.equal(bad.outcome.applied, false);
    const ok = draft.reorderDay(1, ['a2', 'a1']);
    assert.equal(ok.outcome.applied, true);
    assert.deepEqual(draft.current().days[0]!.activities.map((a) => a.id), ['a2', 'a1']);
    assert.deepEqual(draft.current().days[0]!.legs, []);
    const [first, second] = draft.current().days[0]!.activities;
    assert.ok(second!.startTime >= first!.endTime, '重排后时刻必须按新顺序重算');
  });

  it('顺序未变化时不产生改动', () => {
    const draft = createTripDraft(baseTrip());
    const result = draft.reorderDay(1, ['a1', 'a2']);
    assert.equal(result.outcome.applied, false);
    assert.equal(draft.changed(), false);
  });
});

describe('day 增删改', () => {
  it('新增放在末尾，标题缺省第N天', () => {
    const draft = createTripDraft(baseTrip());
    const result = draft.addDay();
    assert.equal(result.outcome.applied, true);
    const days = draft.current().days;
    assert.equal(days.length, 3);
    assert.equal(days[2]!.title, '第3天');
    assert.equal(days[2]!.dayIndex, 3);
  });

  it('删除中间一天后编号连续', () => {
    const draft = createTripDraft(baseTrip());
    const result = draft.deleteDay(1);
    assert.equal(result.outcome.applied, true);
    const days = draft.current().days;
    assert.equal(days.length, 1);
    assert.equal(days[0]!.dayIndex, 1);
    assert.equal(days[0]!.title, '博物馆日');
  });

  it('只剩一天时拒绝删除', () => {
    const trip = baseTrip();
    trip.days = [trip.days[0]!];
    const draft = createTripDraft(trip);
    const result = draft.deleteDay(1);
    assert.equal(result.outcome.applied, false);
    assert.match(result.outcome.summary, /至少保留一天/);
  });

  it('改当天主题', () => {
    const draft = createTripDraft(baseTrip());
    const result = draft.updateDay(2, '博物馆与夜市');
    assert.equal(result.outcome.applied, true);
    assert.equal(draft.current().days[1]!.title, '博物馆与夜市');
  });
});

describe('update_trip', () => {
  it('校验日期与人数字段', () => {
    const draft = createTripDraft(baseTrip());
    assert.equal(draft.updateTrip({ startDate: '2026/11/10' }).outcome.applied, false);
    assert.equal(draft.updateTrip({ partySize: 0 }).outcome.applied, false);
    assert.equal(draft.updateTrip({ budgetLevel: '奢华' }).outcome.applied, false);
    assert.equal(draft.changed(), false);
  });

  it('偏好去重并按字段顺序汇总', () => {
    const draft = createTripDraft(baseTrip());
    const result = draft.updateTrip({ preferences: ['美食', '美食', '文化'], partySize: 4, totalBudget: 5000 });
    assert.equal(result.outcome.applied, true);
    assert.deepEqual(draft.current().preferences, ['美食', '文化']);
    assert.equal(draft.current().partySize, 4);
    assert.equal(draft.current().totalBudget, 5000);
  });

  it('改出行方式会清空全行程通勤段', () => {
    const draft = createTripDraft(baseTrip());
    const result = draft.updateTrip({ transportMode: 'drive' });
    assert.equal(result.outcome.applied, true);
    for (const day of draft.current().days) assert.deepEqual(day.legs, []);
  });
});

describe('快照与台账', () => {
  it('snapshot 是深拷贝，改动不会污染草稿', () => {
    const draft = createTripDraft(baseTrip());
    draft.addDay();
    const snapshot = draft.snapshot();
    snapshot.days[0]!.title = '被外部改了';
    assert.equal(draft.current().days[0]!.title, '市区漫步');
  });

  it('按顺序累积 outcome，拒绝的也在里面但不计入 changed', () => {
    const draft = createTripDraft(baseTrip());
    draft.addActivity({ dayIndex: 1, name: '人民公园' });     // 拒绝
    draft.updateDay(1, '市区慢走');                            // 通过
    const outcomes = draft.outcomes();
    assert.equal(outcomes.length, 2);
    assert.deepEqual(outcomes.map((item) => item.applied), [false, true]);
    assert.equal(draft.changed(), true);
  });

  it('原始行程对象不被修改', () => {
    const trip = baseTrip();
    const before = JSON.stringify(trip);
    const draft = createTripDraft(trip);
    draft.deleteDay(2);
    assert.equal(JSON.stringify(trip), before);
  });
});
