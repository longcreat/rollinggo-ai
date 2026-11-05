// 单测：可行性引擎（时空模拟器）—— 每类违规正例/反例 + 降级边界（node:test，经 tsx 运行）
// 引擎为纯函数（@tripweaver/shared/feasibility），本文件同时覆盖 submit_plan 硬门槛的耗尽降级路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEASIBILITY_THRESHOLDS,
  describeFeasibility,
  feasibilityReviewNotes,
  simulateDay,
  simulateTrip,
  type Activity,
  type DaySimContext,
  type GenerateForm,
  type TransitLeg,
  type Trip,
  type TripDay,
} from '@tripweaver/shared';
import { DraftTrip } from '../generation/draft';
import { buildSubmitPlanTool } from '../generation/tools/draftTools';

// ---------- 夹具 ----------

function activity(id: string, over: Partial<Activity> = {}): Activity {
  return {
    id,
    name: `活动${id}`,
    startTime: '',
    endTime: '',
    description: '',
    lat: 0,
    lng: 0,
    coordSource: 'estimated',
    category: '其他',
    sourceNotes: [],
    ...over,
  };
}

function leg(from: string, to: string, over: Partial<TransitLeg> = {}): TransitLeg {
  return { fromActivityId: from, toActivityId: to, mode: 'transit', durationMin: 10, distanceM: 1000, source: 'heuristic', ...over };
}

function day(activities: Activity[], legs?: TransitLeg[]): TripDay {
  return { id: 'd', dayIndex: 1, title: '', activities, ...(legs ? { legs } : {}) };
}

const ctx = (over: Partial<DaySimContext> = {}): DaySimContext => ({ dayIndex: 1, baseMode: 'transit', ...over });

// 上海一带真实经纬度（GCJ-02 量级），用于通勤/折返几何
const P = { lat: 31.23, lng: 121.47 };
const east = (deg: number) => ({ lat: P.lat, lng: P.lng + deg });

// ---------- transit_infeasible（硬） ----------

test('transit_infeasible：真实 leg 时长 > 相邻活动时间间隔 → 硬违规', () => {
  const acts = [
    activity('a1', { startTime: '09:00', endTime: '10:00', ...P }),
    activity('a2', { startTime: '10:10', endTime: '11:00', ...east(0.01) }),
  ];
  const d = day(acts, [leg('a1', 'a2', { durationMin: 30, source: 'amap' })]);
  const report = simulateDay(d, ctx());
  const v = report.violations.find((x) => x.code === 'transit_infeasible');
  assert.ok(v, '应报 transit_infeasible');
  assert.equal(v!.severity, 'hard');
  assert.equal(v!.detail, undefined, '有真实 leg 不应标注低置信');
});

test('transit_infeasible 反例：通勤时长 ≤ 间隔 → 不报', () => {
  const acts = [
    activity('a1', { startTime: '09:00', endTime: '10:00', ...P }),
    activity('a2', { startTime: '10:30', endTime: '11:00', ...east(0.01) }),
  ];
  const d = day(acts, [leg('a1', 'a2', { durationMin: 20, source: 'amap' })]);
  const report = simulateDay(d, ctx());
  assert.equal(report.violations.some((x) => x.code === 'transit_infeasible'), false);
});

test('transit_infeasible：无 leg 用 haversine 兜底并标注低置信', () => {
  const acts = [
    activity('a1', { startTime: '09:00', endTime: '10:00', ...P }),
    activity('a2', { startTime: '10:05', endTime: '11:00', ...east(0.05) }),   // ~4.7km，transit 估算 >5min 间隔
  ];
  const report = simulateDay(day(acts), ctx());
  const v = report.violations.find((x) => x.code === 'transit_infeasible');
  assert.ok(v, '兜底估算也应能判 transit_infeasible');
  assert.match(v!.detail ?? '', /低置信/);
});

// ---------- overpacked（硬 + 软） ----------

test('overpacked 硬：单日总时长 > 14h', () => {
  const acts = [activity('a1', { startTime: '08:00', endTime: '23:00', ...P })];   // 900min 占用
  const report = simulateDay(day(acts), ctx());
  const v = report.violations.find((x) => x.code === 'overpacked' && x.severity === 'hard');
  assert.ok(v, '应报 overpacked 硬违规');
  assert.ok(report.totalMinutes > FEASIBILITY_THRESHOLDS.hardDayTotalMin);
});

test('overpacked 硬反例：总时长在阈值内 → 不报硬', () => {
  const acts = [activity('a1', { startTime: '09:00', endTime: '17:00', ...P })];   // 480min
  const report = simulateDay(day(acts), ctx());
  assert.equal(report.violations.some((x) => x.code === 'overpacked' && x.severity === 'hard'), false);
});

test('overpacked 软：活动数 > 8', () => {
  const acts = Array.from({ length: 9 }, (_, i) => activity(`a${i}`));
  const report = simulateDay(day(acts), ctx());
  const v = report.violations.find((x) => x.code === 'overpacked' && x.severity === 'soft' && /9 个活动/.test(x.message));
  assert.ok(v, '9 个活动应报节奏偏赶软违规');
});

test('overpacked 软：步行累计 > 15km（leg 距离累加，与坐标无关）', () => {
  const acts = [activity('a1'), activity('a2'), activity('a3')];
  const legs = [
    leg('a1', 'a2', { mode: 'walk', distanceM: 8000, durationMin: 100 }),
    leg('a2', 'a3', { mode: 'walk', distanceM: 8000, durationMin: 100 }),
  ];
  const report = simulateDay(day(acts, legs), ctx());
  assert.equal(report.walkingMeters, 16000);
  assert.ok(report.violations.some((x) => x.code === 'overpacked' && /步行/.test(x.message)));
});

test('overpacked 软：缓冲比 < 10%（时间窗几乎排满）', () => {
  const acts = [
    activity('a1', { startTime: '09:00', endTime: '12:00', ...P }),
    activity('a2', { startTime: '12:10', endTime: '17:00', ...east(0.001) }),
  ];
  const legs = [leg('a1', 'a2', { mode: 'walk', distanceM: 200, durationMin: 5 })];
  const report = simulateDay(day(acts, legs), ctx());
  assert.ok(report.bufferRatio !== null && report.bufferRatio < FEASIBILITY_THRESHOLDS.softBufferRatio);
  assert.ok(report.violations.some((x) => x.code === 'overpacked' && /缓冲/.test(x.message)));
});

// ---------- backtrack（软） ----------

test('backtrack：相邻三点回折 > 90° 且回跳 > 2km', () => {
  const acts = [
    activity('a1', { ...P }),
    activity('a2', { ...east(0.03) }),   // 东行 ~2.9km
    activity('a3', { ...P }),            // 折回起点 ~2.9km > 2km
  ];
  const report = simulateDay(day(acts), ctx());
  const v = report.violations.find((x) => x.code === 'backtrack');
  assert.ok(v, '明显回折应报 backtrack');
  assert.equal(v!.severity, 'soft');
  assert.equal(v!.activityId, 'a3');
});

test('backtrack 反例：三点共线同向 → 不报', () => {
  const acts = [activity('a1', { ...P }), activity('a2', { ...east(0.03) }), activity('a3', { ...east(0.06) })];
  const report = simulateDay(day(acts), ctx());
  assert.equal(report.violations.some((x) => x.code === 'backtrack'), false);
});

test('backtrack 降级：任一点无坐标 → 跳过不误报', () => {
  const acts = [activity('a1', { ...P }), activity('a2'), activity('a3', { ...P })];   // a2 无坐标
  const report = simulateDay(day(acts), ctx());
  assert.equal(report.violations.some((x) => x.code === 'backtrack'), false);
});

// ---------- anchor_missing（软） ----------

test('anchor_missing：住宿已指定但坐标未解析（解析已尝试）', () => {
  const report = simulateDay(day([activity('a1', { ...P })]), ctx({ lodging: { name: '西湖景区周边' }, anchorResolutionAttempted: true }));
  assert.ok(report.violations.some((x) => x.code === 'anchor_missing'));
});

test('anchor_missing 反例：住宿有坐标 → 不报', () => {
  const report = simulateDay(day([activity('a1', { ...P })]), ctx({ lodging: { name: '西湖', ...east(0.001) }, anchorResolutionAttempted: true }));
  assert.equal(report.violations.some((x) => x.code === 'anchor_missing'), false);
});

test('anchor_missing 抑制：解析尚未尝试（geoPipeline 前）→ 不报噪声', () => {
  const report = simulateDay(day([activity('a1', { ...P })]), ctx({ lodging: { name: '西湖景区周边' }, anchorResolutionAttempted: false }));
  assert.equal(report.violations.some((x) => x.code === 'anchor_missing'), false);
});

// ---------- 边界 ----------

test('空天：无活动 → 无违规、无崩溃', () => {
  const report = simulateDay(day([]), ctx());
  assert.equal(report.activityCount, 0);
  assert.equal(report.violations.length, 0);
  assert.equal(report.bufferRatio, null);
});

test('单活动天：无通勤/折返/缓冲判定', () => {
  const report = simulateDay(day([activity('a1', { startTime: '09:00', endTime: '11:00', ...P })]), ctx());
  assert.equal(report.transitMinutes, 0);
  assert.equal(report.bufferRatio, null);
  assert.equal(report.violations.length, 0);
});

test('降级：两活动均无坐标且无 leg → 通勤无法判定，跳过不误报', () => {
  const acts = [
    activity('a1', { startTime: '09:00', endTime: '10:00' }),
    activity('a2', { startTime: '10:01', endTime: '11:00' }),   // 间隔仅 1min，但无坐标无法算通勤
  ];
  const report = simulateDay(day(acts), ctx());
  assert.equal(report.transitMinutes, 0);
  assert.equal(report.violations.some((x) => x.code === 'transit_infeasible'), false);
});

// ---------- simulateTrip / 渲染 / 降级说明 ----------

function trip(days: TripDay[], over: Partial<Trip> = {}): Trip {
  return {
    id: 't1',
    title: 'T',
    destination: '上海',
    startDate: '',
    budgetLevel: '舒适',
    totalBudget: 0,
    preferences: [],
    partySize: 2,
    extraNotes: '',
    days,
    meta: { usedXhs: false, reviewNotes: [] },
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

test('simulateTrip：anchor_missing 仅在坐标已解析后才判（靠 geocoded/legs 推断）', () => {
  // 全 estimated 且无 leg → 视为 geoPipeline 未跑 → 抑制 anchor_missing
  const preGeo = simulateTrip(trip([day([activity('a1', { ...P })])], { lodging: { name: '西湖' } }));
  assert.equal(preGeo.violations.some((x) => x.code === 'anchor_missing'), false);
  // 有 geocoded 活动 → 已解析 → 住宿缺坐标应报 anchor_missing
  const postGeo = simulateTrip(
    trip([day([activity('a1', { ...P, coordSource: 'geocoded' })])], { lodging: { name: '西湖' } }),
  );
  assert.ok(postGeo.violations.some((x) => x.code === 'anchor_missing'));
});

test('describeFeasibility：无违规给明确通过结论；有硬违规分区展示', () => {
  assert.match(describeFeasibility({ dayReports: [], violations: [] }), /通过/);
  const acts = [activity('a1', { startTime: '08:00', endTime: '23:00', ...P })];
  const withHard = simulateTrip(trip([day(acts)]));
  const text = describeFeasibility(withHard);
  assert.match(text, /硬性问题/);
});

test('feasibilityReviewNotes：hard 在前、去重、限量（守生成不失败的降级说明）', () => {
  const acts = [activity('a1', { startTime: '08:00', endTime: '23:00', ...P })];
  const report = simulateTrip(trip([day(acts), day(acts)]));   // 两天同样过载
  const notes = feasibilityReviewNotes(report, 4);
  assert.ok(notes.length > 0 && notes.length <= 4);
  assert.match(notes[0]!, /可行性遗留/);
});

// ---------- submit_plan 硬门槛的耗尽降级（decision 2：不 throw，最终放行交降级） ----------

function draftForm(): GenerateForm {
  return { destination: '上海', days: 1, startDate: '', budgetLevel: '经济', totalBudget: 0, preferences: [], partySize: 1, extraNotes: '' };
}

test('submit_plan 硬门槛：hard 违规先阻断回灌清单，连续 3 次后放行（不死循环）', async () => {
  const draft = new DraftTrip(draftForm());
  draft.setSkeleton('测试', ['第一天']);
  // 单日 08:00-23:00 → overpacked 硬违规（完整性通过、可行性不通过）
  draft.addActivity(1, { name: 'A（含午餐、晚餐安排）', startTime: '08:00', endTime: '23:00', lat: P.lat, lng: P.lng, coordSource: 'geocoded' });
  assert.equal(draft.validate().length, 0, '完整性应通过');
  assert.ok(draft.feasibility().violations.some((v) => v.severity === 'hard'), '应有 hard 违规');

  let passed = false;
  const tool = buildSubmitPlanTool(draft, () => (passed = true));
  const call = () => tool.execute('c', {} as never) as Promise<{ details?: { pass?: boolean }; terminate?: boolean }>;

  for (let i = 0; i < 3; i++) {
    const r = await call();
    assert.equal(r.details?.pass, false, `第 ${i + 1} 次应被硬门槛阻断`);
    assert.equal(passed, false);
  }
  const final = await call();
  assert.equal(final.details?.pass, true, '连续阻断后放行，交修订轮/降级处理');
  assert.equal(final.terminate, true);
  assert.equal(passed, true);
});

test('submit_plan：可行的草稿一次通过（feasible plan 不被门槛误伤）', async () => {
  const draft = new DraftTrip(draftForm());
  draft.setSkeleton('测试', ['第一天']);
  draft.addActivity(1, { name: 'A', startTime: '09:00', endTime: '11:00', lat: P.lat, lng: P.lng, coordSource: 'geocoded' });
  draft.addActivity(1, { name: '午餐｜市中心 · 当地风味', startTime: '11:30', endTime: '12:30', category: '美食', lat: P.lat, lng: P.lng, coordSource: 'geocoded' });
  draft.addActivity(1, { name: 'B', startTime: '13:00', endTime: '15:00', lat: P.lat, lng: P.lng + 0.005, coordSource: 'geocoded' });
  draft.addActivity(1, { name: '晚餐｜老城 · 当地风味', startTime: '18:00', endTime: '19:00', category: '美食', lat: P.lat, lng: P.lng, coordSource: 'geocoded' });
  let passed = false;
  const tool = buildSubmitPlanTool(draft, () => (passed = true));
  const r = (await tool.execute('c', {} as never)) as { details?: { pass?: boolean } };
  assert.equal(r.details?.pass, true);
  assert.equal(passed, true);
});

// ---------- closed_on_arrival（硬，09-22-opentime） ----------

test('closed_on_arrival：活动安排在闭馆日 → 硬违规', () => {
  const d = day([activity('a1', { name: '某博物馆', openTime: '09:00-17:00；周一闭馆' })]);
  // 2026-09-21 = 周一
  const report = simulateDay(d, ctx({ date: '2026-09-21' }));
  const v = report.violations.find((x) => x.code === 'closed_on_arrival');
  assert.ok(v, '周一闭馆的活动排在周一应报硬违规');
  assert.equal(v.severity, 'hard');
  assert.equal(v.activityId, 'a1');
});

test('closed_on_arrival：开放日 / 无 openTime / 无日期 → 不报', () => {
  const closed = day([activity('a1', { name: '某博物馆', openTime: '09:00-17:00；周一闭馆' })]);
  // 周二（开放日）不报
  assert.equal(simulateDay(closed, ctx({ date: '2026-09-22' })).violations.filter((x) => x.code === 'closed_on_arrival').length, 0);
  // 无 openTime 的活动不报
  const noInfo = day([activity('a2')]);
  assert.equal(simulateDay(noInfo, ctx({ date: '2026-09-21' })).violations.filter((x) => x.code === 'closed_on_arrival').length, 0);
  // 无日期（startDate 未定）整体跳过
  assert.equal(simulateDay(closed, ctx()).violations.filter((x) => x.code === 'closed_on_arrival').length, 0);
});

test('simulateTrip：按 startDate + dayIndex 推日期，第二天撞闭馆日也报', () => {
  const trip = {
    ...JSON.parse(JSON.stringify({})),
    id: 't', title: '测试', destination: '北京', startDate: '2026-09-20', // 周日
    budgetLevel: '舒适', totalBudget: 0, preferences: [], partySize: 2, extraNotes: '',
    days: [
      { id: 'd1', dayIndex: 1, title: '', activities: [activity('a1', { name: '露天公园', openTime: '周一闭馆' })] },
      { id: 'd2', dayIndex: 2, title: '', activities: [activity('a2', { name: '某馆', openTime: '周一闭馆' })] },
    ],
    meta: { usedXhs: false, reviewNotes: [] }, createdAt: 0, updatedAt: 0,
  } as unknown as Trip;
  const report = simulateTrip(trip);
  // day1 = 周日（开放）不报；day2 = 周一（闭馆）报
  assert.equal(report.violations.filter((v) => v.code === 'closed_on_arrival').length, 1);
  assert.equal(report.violations[0]!.dayIndex, 2);
});
