// 动线重算判定：改名、改出行方式、增删活动都必须触发重算，未变的一天不能重复调路线服务。
// 纯函数，不连库不发请求。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Trip, TripDay } from '@tripweaver/shared';
import { dayNeedsRouteRepair, routePairsFor } from '@tripweaver/services/routeRepairPlan';

function activity(id: string, name: string, lat: number, lng: number) {
  return {
    id, name, startTime: '', endTime: '', description: '', lat, lng,
    coordSource: 'geocoded' as const, coordSystem: 'gcj02' as const, category: '文化' as const, sourceNotes: [],
  };
}

function trip(transportMode: Trip['transportMode'] = 'transit'): Trip {
  const day: TripDay = {
    id: 'd1', dayIndex: 1, title: '市区',
    activities: [activity('a1', '人民公园', 30.6612, 104.0625), activity('a2', '宽窄巷子', 30.6691, 104.0553)],
    legs: [],
  };
  return {
    id: 't1', title: '成都', destination: '成都', startDate: '2026-11-10', budgetLevel: '舒适',
    totalBudget: 3000, preferences: [], partySize: 2, extraNotes: '', transportMode,
    lodging: { name: '酒店', lat: 30.652, lng: 104.081, coordSystem: 'gcj02' },
    days: [day], meta: { usedXhs: false, reviewNotes: [] }, createdAt: 1, updatedAt: 1,
  };
}

/** 用 routePairsFor 生成「完整且方式正确」的 legs，避免在测试里硬编码步行/骑行阈值。 */
function completeLegs(t: Trip, day: TripDay) {
  return routePairsFor(day, t).map((pair) => ({
    fromActivityId: pair.from.id, toActivityId: pair.to.id, mode: pair.mode,
    durationMin: 10, distanceM: 800, source: 'heuristic' as const,
  }));
}

describe('routePairsFor', () => {
  it('住宿参与首尾两段：住宿→首活动、中间相邻、末活动→住宿', () => {
    const t = trip();
    const pairs = routePairsFor(t.days[0]!, t);
    assert.deepEqual(pairs.map((pair) => `${pair.from.id}->${pair.to.id}`), [
      'lodging->a1', 'a1->a2', 'a2->lodging',
    ]);
  });

  it('无坐标的活动不产生通勤对（否则会永远缺 leg、反复重算）', () => {
    const t = trip();
    const day: TripDay = {
      id: 'd2', dayIndex: 2, title: '待定', legs: [],
      activities: [activity('b1', '已定位', 30.66, 104.06), { ...activity('b2', '未定位', 0, 0), coordSource: 'estimated' }],
    };
    const pairs = routePairsFor(day, t);
    assert.deepEqual(pairs.map((pair) => `${pair.from.id}->${pair.to.id}`), ['lodging->b1']);
  });
});

describe('dayNeedsRouteRepair', () => {
  it('legs 齐全且方式正确时返回 false（不重复打路线服务）', () => {
    const t = trip();
    const day = t.days[0]!;
    day.legs = completeLegs(t, day);
    assert.equal(dayNeedsRouteRepair(t.days[0]!, day, t), false);
  });

  it('活动 id 变化时返回 true', () => {
    const t = trip();
    const day = t.days[0]!;
    day.legs = completeLegs(t, day);
    const previous = { ...day, activities: [day.activities[0]!] };
    assert.equal(dayNeedsRouteRepair(previous, day, t), true);
  });

  it('只改名（legs 被清空、id 不变）也必须重算', () => {
    const t = trip();
    const previous = structuredClone(t.days[0]!);
    previous.legs = completeLegs(t, previous);
    const day = structuredClone(previous);
    day.activities[0]!.name = '成都博物馆';
    day.legs = [];   // 改名 = 换地点，草稿层会清空 legs
    assert.equal(dayNeedsRouteRepair(previous, day, t), true);
  });

  it('只改出行方式（全行程 legs 被清空）也必须重算', () => {
    const t = trip();
    const previous = structuredClone(t.days[0]!);
    previous.legs = completeLegs(t, previous);
    const next = trip('drive');
    next.days[0]!.activities = structuredClone(previous.activities);
    next.days[0]!.legs = [];
    assert.equal(dayNeedsRouteRepair(previous, next.days[0]!, next), true);
    assert.ok(routePairsFor(next.days[0]!, next).every((pair) => pair.mode === 'drive' || pair.mode === 'walk'));
  });

  it('leg 的方式与当前基调不符时返回 true（旧 legs 不能被当成新方式的结果）', () => {
    const t = trip();
    const previous = structuredClone(t.days[0]!);
    previous.legs = completeLegs(t, previous);
    const next = trip('drive');
    next.days[0]!.activities = structuredClone(previous.activities);
    next.days[0]!.legs = previous.legs.map((leg) => ({ ...leg, mode: 'transit' as const }));
    assert.equal(dayNeedsRouteRepair(previous, next.days[0]!, next), true);
  });
});
