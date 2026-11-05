// 单测：确定性修复器（远郊编排层3 兜底，node:test 经 tsx 运行）
// 覆盖：模式识别（混排命中/独占日不误伤/无长途点不触发/近邻保留/无坐标不判定）、
// 目标天选择（最轻负载优先、排除独占天与满员天）、时间槽（取整/walk 镜像/晚间边界/置空兜底）、
// 验证闭环（采纳与回滚双路径）、防死循环上限（每天 ≤3 挪动、总尝试 ≤8）、只挪不删不变量、
// 落库注记真话契约（verifiedFixNotes：修订轮推翻挪动后失真注记须被过滤）、
// beijing Day3 金标（固化基线快照数据：南来顺+鸟巢挪出、修后 hard=0、活动总数不变）。
// 金标数字与 legs.test.ts / longHaul.test.ts 同源（金集快照 GCJ-02 坐标）；调速度模型/阈值时有意识更新。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LODGING_SENTINEL,
  effectiveLegMode,
  estimateTransit,
  haversineMeters,
  type Activity,
  type DayReport,
  type GenerateForm,
  type LegMode,
  type Lodging,
  type TransitLeg,
} from '@tripweaver/shared';
import { DraftTrip } from '../generation/draft';
import {
  MAX_MOVES_PER_DAY,
  MAX_TOTAL_ATTEMPTS,
  NEAR_STOPOVER_MAX_MIN,
  computeMoveSlot,
  rankTargetDays,
  repairLongHaulMixedDays,
  scanMixedDay,
  verifiedFixNotes,
  type DraftDay,
} from '../generation/longHaulFixer';

// ---------- 夹具 ----------

function form(days: number): GenerateForm {
  return {
    destination: '测试市',
    days,
    startDate: '',
    budgetLevel: '舒适',
    totalBudget: 0,
    preferences: [],
    partySize: 2,
    extraNotes: '',
    transportMode: 'transit',
  };
}

function act(id: string, over: Partial<Activity> = {}): Activity {
  return {
    id,
    name: `活动${id}`,
    startTime: '',
    endTime: '',
    description: '',
    lat: 0,
    lng: 0,
    coordSource: 'geocoded',
    category: '其他',
    sourceNotes: [],
    ...over,
  };
}

const dayOf = (activities: Activity[]): DraftDay => ({ title: '', activities });

interface ActSpec {
  name: string;
  lat: number;
  lng: number;
  startTime?: string;
  endTime?: string;
}

/** 合成行程草稿：无住宿锚点（住宿 leg 路径由金标覆盖），坐标按 geocoded 视为已解析 */
function buildDraft(daySpecs: ActSpec[][]): DraftTrip {
  const draft = new DraftTrip(form(daySpecs.length));
  draft.setSkeleton(
    '合成行程',
    daySpecs.map((_, i) => `第${i + 1}天`),
  );
  daySpecs.forEach((specs, i) => {
    for (const s of specs) draft.addActivity(i + 1, { ...s, coordSource: 'geocoded' });
  });
  return draft;
}

/** 测试版 legs 重算：纯启发式镜像 geoPipeline（<1.5km 走路、住宿哨兵 leg），并记录调用次数 */
function heuristicRecompute(draft: DraftTrip, counter = { n: 0 }) {
  const fn = async (dayIndexes: readonly number[]): Promise<void> => {
    counter.n += 1;
    const days = draft.mutableDays();
    const lodging = draft.lodging;
    const lodgingPoint =
      lodging && typeof lodging.lat === 'number' && typeof lodging.lng === 'number' && (lodging.lat !== 0 || lodging.lng !== 0)
        ? { id: LODGING_SENTINEL, lat: lodging.lat, lng: lodging.lng }
        : null;
    const hasCoord = (p: { lat: number; lng: number }) => !(p.lat === 0 && p.lng === 0);
    const pair = (from: { id: string; lat: number; lng: number }, to: { id: string; lat: number; lng: number }): TransitLeg => {
      const mode: LegMode = effectiveLegMode(from, to, 'transit');
      return { fromActivityId: from.id, toActivityId: to.id, mode, ...estimateTransit(from, to, mode), source: 'heuristic' };
    };
    for (const di of dayIndexes) {
      const day = days[di - 1];
      if (!day) continue;
      const legs: TransitLeg[] = [];
      for (let i = 0; i + 1 < day.activities.length; i++) {
        const from = day.activities[i]!;
        const to = day.activities[i + 1]!;
        if (hasCoord(from) && hasCoord(to)) legs.push(pair(from, to));
      }
      const first = day.activities[0];
      const last = day.activities[day.activities.length - 1];
      if (lodgingPoint && first && last) {
        if (hasCoord(first)) legs.unshift(pair(lodgingPoint, first));
        if (hasCoord(last)) legs.push(pair(last, lodgingPoint));
      }
      day.legs = legs;
    }
  };
  return { fn, counter };
}

const allIds = (draft: DraftTrip): string[] =>
  draft
    .mutableDays()
    .flatMap((d) => d.activities.map((a) => a.id))
    .sort();

const hardCount = (draft: DraftTrip): number => draft.feasibility().violations.filter((v) => v.severity === 'hard').length;

const dayNames = (draft: DraftTrip, dayIndex: number): string[] => draft.mutableDays()[dayIndex - 1]!.activities.map((a) => a.name);

// 合成城市几何（30°N/120°E 一带）：市区簇在 120.00-120.02，远郊点北移 0.25°
const CENTER = { lat: 30, lng: 120 };
const FAR = { lat: 30.25, lng: 120 };        // 距市区簇约 27km：transit 估算 ~94-95min → 强独占级
const NEAR_FAR = { lat: 30.19, lng: 120 };   // 距远郊点 ~6.7km（38min ≤45 近邻）、距市区 ~83min（<90 非独占）
const URBAN = { lat: 30.005, lng: 120.005 }; // 市区簇内

// ---------- 模式识别 scanMixedDay ----------

test('scanMixedDay 命中：远郊日混排 → 长途点/近邻/市区候选正确分组', () => {
  const day = dayOf([act('f', FAR), act('n', NEAR_FAR), act('u', URBAN)]);
  const scan = scanMixedDay(day, 1, CENTER, 'transit');
  assert.ok(scan, '含强独占级长途点应命中');
  assert.deepEqual(scan.longHaulActivities.map((a) => a.id), ['f']);
  // 近邻（≤45min）保留在远郊日，不进挪出候选；市区点进候选
  assert.ok(estimateTransit(NEAR_FAR, FAR, 'transit').durationMin <= NEAR_STOPOVER_MAX_MIN, '几何前提：近邻点须 ≤45min');
  assert.deepEqual(scan.urbanCandidates.map((a) => a.id), ['u']);
});

test('scanMixedDay 独占日不误伤：仅长途点无市区活动 → 无挪出候选', () => {
  const scan = scanMixedDay(dayOf([act('f', FAR)]), 1, CENTER, 'transit');
  assert.ok(scan);
  assert.deepEqual(scan.urbanCandidates, []);
});

test('scanMixedDay 无长途点日不触发（长途级 60-90min 不算强独占）', () => {
  // NEAR_FAR 距中心 ~83min：长途级但非强独占级 → 整天不判为远郊日
  assert.equal(scanMixedDay(dayOf([act('n', NEAR_FAR), act('u', URBAN)]), 1, CENTER, 'transit'), null);
});

test('scanMixedDay 无坐标活动不判定（保守不动）', () => {
  const scan = scanMixedDay(dayOf([act('f', FAR), act('z', { lat: 0, lng: 0 })]), 1, CENTER, 'transit');
  assert.ok(scan);
  assert.deepEqual(scan.urbanCandidates, [], '无坐标活动不得进挪出候选');
});

// ---------- 目标天选择 rankTargetDays ----------

const dr = (dayIndex: number, totalMinutes: number): DayReport => ({
  dayIndex,
  activityCount: 0,
  activityMinutes: 0,
  transitMinutes: 0,
  totalMinutes,
  walkingMeters: 0,
  bufferRatio: null,
  violations: [],
});

test('rankTargetDays：负载最轻优先；排除源天/含强独占点天/满员天', () => {
  const days: DraftDay[] = [
    dayOf([act('s', FAR)]),                                                        // day1 源天
    dayOf([act('l', { lat: 30.001, lng: 120.001 })]),                              // day2 轻
    dayOf([act('h', { lat: 30.002, lng: 120.002 })]),                              // day3 重
    dayOf([act('x', FAR)]),                                                        // day4 含强独占点 → 排除（避免再造混排）
    dayOf(Array.from({ length: 8 }, (_, k) => act(`f${k}`, { lat: 30.003, lng: 120.003 }))), // day5 满员 → 排除
  ];
  const reports = [dr(1, 500), dr(2, 200), dr(3, 400), dr(4, 100), dr(5, 100)];
  assert.deepEqual(rankTargetDays(days, reports, 1, CENTER, 'transit'), [2, 3]);
});

// ---------- 时间槽 computeMoveSlot ----------

test('computeMoveSlot：末活动结束 + 估算通勤，向后取整到 :00/:30，保持原时长', () => {
  const target = dayOf([act('p', { ...CENTER, startTime: '09:00', endTime: '17:00' })]);
  // 距末活动 ~11.1km：transit 估算 57min → 17:57 → 取整 18:00；原时长 90min 保持
  const slot = computeMoveSlot(target, act('m', { lat: 30.1, lng: 120, startTime: '18:00', endTime: '19:30' }), 'transit');
  assert.deepEqual(slot, { startTime: '18:00', endTime: '19:30' });
});

test('computeMoveSlot：取整落在 :30', () => {
  const target = dayOf([act('p', { ...CENTER, startTime: '09:00', endTime: '17:00' })]);
  // ~3.3km：transit 24min → 17:24 → 17:30
  const slot = computeMoveSlot(target, act('m', { lat: 30.03, lng: 120, startTime: '18:00', endTime: '19:30' }), 'transit');
  assert.deepEqual(slot, { startTime: '17:30', endTime: '19:00' });
});

test('computeMoveSlot：556m 段判步行（10min）→ 16:30；若误用 transit（12min）会取整到 17:00', () => {
  const target = dayOf([act('p', { ...CENTER, startTime: '09:00', endTime: '16:20' })]);
  // 直线 0.005°≈556m → 绕行 778m → walk 10min → 16:30（09-22 起改按时长判步行，不再按直线距离）
  const slot = computeMoveSlot(target, act('m', { lat: 30.005, lng: 120, startTime: '18:00', endTime: '19:00' }), 'transit');
  assert.deepEqual(slot, { startTime: '16:30', endTime: '17:30' });
});

test('computeMoveSlot：1.4km 段判骑行（12min）→ 16:30（超出步行上限但不值得上公交）', () => {
  const target = dayOf([act('p', { ...CENTER, startTime: '09:00', endTime: '16:10' })]);
  // 直线 ~1.45km：走路 27min 超上限 → 骑行 12min → 16:22 → 16:30
  const slot = computeMoveSlot(target, act('m', { lat: 30.013, lng: 120, startTime: '18:00', endTime: '19:00' }), 'transit');
  assert.deepEqual(slot, { startTime: '16:30', endTime: '17:30' });
});

test('computeMoveSlot：结束压过晚间边界 23:00 → null（该天放不下）', () => {
  const target = dayOf([act('p', { ...CENTER, startTime: '09:00', endTime: '22:00' })]);
  const slot = computeMoveSlot(target, act('m', { lat: 30.03, lng: 120, startTime: '18:00', endTime: '19:30' }), 'transit');
  assert.equal(slot, null);
});

test('computeMoveSlot：基准/原时长不可推演 → 置空时间兜底（不臆造）', () => {
  // 目标天无有效结束时间
  const noBase = dayOf([act('p', { ...CENTER })]);
  assert.deepEqual(computeMoveSlot(noBase, act('m', { lat: 30.03, lng: 120, startTime: '18:00', endTime: '19:30' }), 'transit'), {
    startTime: '',
    endTime: '',
  });
  // 被挪活动无有效时长
  const target = dayOf([act('p', { ...CENTER, startTime: '09:00', endTime: '17:00' })]);
  assert.deepEqual(computeMoveSlot(target, act('m', { lat: 30.03, lng: 120 }), 'transit'), { startTime: '', endTime: '' });
});

// ---------- 验证闭环：采纳路径 ----------

test('修复采纳：混排市区活动挪到最轻天、时间槽可推演、hard 清零、只挪不删', async () => {
  const draft = buildDraft([
    [
      { name: '超远大佛景区', ...FAR, startTime: '09:00', endTime: '15:00' },
      { name: '老城名小吃', ...URBAN, startTime: '15:30', endTime: '17:00' },   // gap 30 < 估算 ~94min → hard
    ],
    [
      { name: '甲馆', lat: 30, lng: 120, startTime: '09:00', endTime: '10:00' },
      { name: '乙园', lat: 30.01, lng: 120.01, startTime: '11:00', endTime: '12:00' },
    ],
    [
      { name: '丙寺', lat: 29.995, lng: 119.995, startTime: '09:00', endTime: '12:00' },
      { name: '丁街', lat: 30.015, lng: 120.015, startTime: '13:00', endTime: '16:00' },
    ],
  ]);
  const idsBefore = allIds(draft);
  assert.equal(hardCount(draft), 1, '前置：源天应有 1 个 hard（transit_infeasible）');

  const { fn, counter } = heuristicRecompute(draft);
  const fix = await repairLongHaulMixedDays(draft, { mode: 'transit', recomputeLegs: fn });

  assert.equal(fix.applied.length, 1);
  assert.deepEqual(dayNames(draft, 1), ['超远大佛景区'], '远郊日只留长途点');
  // 第 2 天最轻（120+27min < 360+22min）→ 目标天；槽位 = 12:00 + walk 14min → 取整 12:30，原时长 90min
  const moved = draft.mutableDays()[1]!.activities.at(-1)!;
  assert.equal(moved.name, '老城名小吃');
  assert.equal(moved.startTime, '12:30');
  assert.equal(moved.endTime, '14:00');
  assert.equal(hardCount(draft), 0, '修后 hard 清零');
  assert.deepEqual(allIds(draft), idsBefore, '只挪不删：活动 id 集不变');
  assert.equal(fix.applied[0]!.activityId, moved.id, '挪动记录持有被挪活动的稳定 id');
  assert.equal(fix.applied[0]!.toDayIndex, 2, '挪动记录持有目标天');
  assert.match(fix.applied[0]!.note, /系统自动调整：「老城名小吃」自第 1 天移至第 2 天/);
  assert.match(fix.applied[0]!.note, /「超远大佛景区」/);
  assert.ok(counter.n >= 1 && counter.n <= MAX_TOTAL_ATTEMPTS);
});

// ---------- 验证闭环：回滚路径 ----------

test('修复回滚：所有目标天验证不过（挪入即过载）→ 整日完整回滚、草稿零改动', async () => {
  const draft = buildDraft([
    [
      { name: '超远大佛景区', ...FAR, startTime: '09:00', endTime: '15:00' },
      { name: '老城名小吃', ...URBAN, startTime: '15:30', endTime: '17:00' },
    ],
    [
      { name: '甲馆', lat: 30, lng: 120, startTime: '08:00', endTime: '14:00' },
      { name: '乙园', lat: 30.01, lng: 120.01, startTime: '14:30', endTime: '21:15' },   // 全天 ~800min，再挪入 90min 活动即超 14h
    ],
    [
      { name: '丙寺', lat: 29.995, lng: 119.995, startTime: '08:00', endTime: '14:00' },
      { name: '丁街', lat: 30.015, lng: 120.015, startTime: '14:30', endTime: '20:30' },
    ],
  ]);
  const stateBefore = JSON.stringify(draft.mutableDays());
  assert.equal(hardCount(draft), 1);

  const { fn, counter } = heuristicRecompute(draft);
  const fix = await repairLongHaulMixedDays(draft, { mode: 'transit', recomputeLegs: fn });

  assert.deepEqual(fix.applied, []);
  assert.equal(JSON.stringify(draft.mutableDays()), stateBefore, '回滚须彻底：活动与 legs 逐字节还原');
  assert.ok(counter.n <= MAX_TOTAL_ATTEMPTS, '尝试次数受总上限约束');
  assert.equal(counter.n, 2, '两个候选天各试一次后放弃');
});

test('修复回滚：时间槽全部压过晚间边界 → 不产生任何尝试、草稿零改动', async () => {
  const draft = buildDraft([
    [
      { name: '超远大佛景区', ...FAR, startTime: '09:00', endTime: '15:00' },
      { name: '老城名小吃', ...URBAN, startTime: '15:30', endTime: '17:00' },
    ],
    [{ name: '通宵市集', lat: 30, lng: 120, startTime: '09:00', endTime: '22:30' }],   // 槽位起点 ≥23:00 → 放不下
  ]);
  const stateBefore = JSON.stringify(draft.mutableDays());
  const { fn, counter } = heuristicRecompute(draft);
  const fix = await repairLongHaulMixedDays(draft, { mode: 'transit', recomputeLegs: fn });
  assert.equal(fix.applied.length, 0);
  assert.equal(counter.n, 0, '槽位不可行的天在挪动前就被跳过，不消耗尝试');
  assert.equal(JSON.stringify(draft.mutableDays()), stateBefore);
});

// ---------- 触发边界 ----------

test('无 hard 不动：混排结构存在但可行性通过 → 零改动', async () => {
  const draft = buildDraft([
    [
      { name: '超远大佛景区', ...FAR, startTime: '09:00', endTime: '15:00' },
      { name: '老城名小吃', ...URBAN, startTime: '19:00', endTime: '19:30' },   // gap 240 ≥ 94：无违规
    ],
    [{ name: '甲馆', lat: 30, lng: 120, startTime: '09:00', endTime: '10:00' }],
  ]);
  const stateBefore = JSON.stringify(draft.mutableDays());
  const { fn, counter } = heuristicRecompute(draft);
  const fix = await repairLongHaulMixedDays(draft, { mode: 'transit', recomputeLegs: fn });
  assert.equal(fix.applied.length, 0);
  assert.equal(counter.n, 0);
  assert.equal(JSON.stringify(draft.mutableDays()), stateBefore);
});

test('hard 不落在远郊日则不动手：市区日的 hard 与混排无关 → 零改动', async () => {
  const draft = buildDraft([
    [
      { name: '超远大佛景区', ...FAR, startTime: '09:00', endTime: '15:00' },
      { name: '老城名小吃', ...URBAN, startTime: '19:00', endTime: '19:30' },   // 混排结构但无 hard
    ],
    [
      { name: '甲馆', lat: 30, lng: 120, startTime: '09:00', endTime: '10:00' },
      { name: '乙园', lat: 30.03, lng: 120.03, startTime: '10:05', endTime: '11:00' },   // gap 5 < 通勤 → hard（无长途点日）
    ],
  ]);
  const stateBefore = JSON.stringify(draft.mutableDays());
  const { fn, counter } = heuristicRecompute(draft);
  const fix = await repairLongHaulMixedDays(draft, { mode: 'transit', recomputeLegs: fn });
  assert.equal(fix.applied.length, 0);
  assert.equal(counter.n, 0);
  assert.equal(JSON.stringify(draft.mutableDays()), stateBefore);
});

// ---------- 防死循环上限 ----------

test('防死循环：单日最多挪出 3 个活动（D3 上限），其余留在原天', async () => {
  assert.equal(MAX_MOVES_PER_DAY, 3);
  assert.equal(MAX_TOTAL_ATTEMPTS, 8);
  const draft = buildDraft([
    [
      { name: '超远大佛景区', ...FAR, startTime: '09:00', endTime: '15:00' },
      { name: '市区点一', lat: 30.005, lng: 120.005, startTime: '15:30', endTime: '16:30' },   // gap 30 → hard
      { name: '市区点二', lat: 30.006, lng: 120.006, startTime: '17:00', endTime: '17:30' },
      { name: '市区点三', lat: 30.007, lng: 120.007, startTime: '18:00', endTime: '18:30' },
      { name: '市区点四', lat: 30.008, lng: 120.008, startTime: '19:00', endTime: '19:30' },
    ],
    [
      { name: '甲馆', lat: 30, lng: 120, startTime: '09:00', endTime: '10:00' },
      { name: '乙园', lat: 30.01, lng: 120.01, startTime: '11:00', endTime: '12:00' },
    ],
    [
      { name: '丙寺', lat: 29.995, lng: 119.995, startTime: '09:00', endTime: '12:00' },
      { name: '丁街', lat: 30.015, lng: 120.015, startTime: '13:00', endTime: '16:00' },
    ],
  ]);
  const idsBefore = allIds(draft);
  const { fn, counter } = heuristicRecompute(draft);
  const fix = await repairLongHaulMixedDays(draft, { mode: 'transit', recomputeLegs: fn });

  assert.equal(fix.applied.length, MAX_MOVES_PER_DAY, '第 4 个混排活动不再挪（单日上限）');
  assert.equal(draft.mutableDays()[0]!.activities.length, 2, '远郊日剩长途点 + 1 个未挪活动');
  assert.equal(hardCount(draft), 0);
  assert.deepEqual(allIds(draft), idsBefore, '只挪不删');
  assert.ok(counter.n <= MAX_TOTAL_ATTEMPTS);
});

// ---------- beijing Day3 金标（固化基线快照数据） ----------

/** 金标 fixture 形状：完整快照（form + Trip）的裁剪投影，仅保留 DraftTrip 构造所需字段 */
interface SnapshotFixture {
  form: GenerateForm;
  trip: {
    title: string;
    lodging?: Lodging;
    days: {
      title: string;
      activities: Pick<Activity, 'id' | 'name' | 'startTime' | 'endTime' | 'category' | 'cost' | 'lat' | 'lng' | 'coordSource'>[];
      legs?: TransitLeg[];
    }[];
  };
}

// 金标 fixture 固化自 2026-07-17 基线快照 eval/snapshots/beijing-5d-family.json（commit 756ee7b 时代的
// 坏形态：Day3 八达岭 09:00-15:00 + 南来顺 18:00-19:30 + 鸟巢 20:00-21:00 远郊混排，heuristic 通勤
// 264/267/68/55min → 3 hard）。快照文件会随 live 重生成刷新为修好的形态，故此处内嵌旧数据作为修复器的
// 永久考题，故意不跟随快照文件更新；仅保留构造所需字段（活动 id/name/时间/类目/费用/坐标 + 全量 legs，
// 剔除 polyline 等无关字段）。
const beijingSnapshot: SnapshotFixture = {
  form: {
    destination: '北京',
    days: 5,
    startDate: '',
    budgetLevel: '舒适',
    totalBudget: 8000,
    preferences: ['文化', '亲子'],
    partySize: 3,
    extraNotes: '',
    transportMode: 'transit',
  },
  trip: {
    title: '北京五日亲子文化之旅',
    lodging: {
      name: '前门-崇文门区域（地铁2号线、5号线交汇，步行可达天坛、故宫南端，家庭房选择多）',
      lat: 39.897083,
      lng: 116.398254,
      coordSystem: 'gcj02',
    },
    days: [
      {
        title: '中轴线经典·故宫与皇城',
        activities: [
          { id: 'ee0a95f5-0e7b-46b7-8caa-e345713437de', name: '天安门广场', startTime: '08:00', endTime: '08:30', category: '其他', cost: 0, lat: 39.903182, lng: 116.397755, coordSource: 'geocoded' },
          { id: '2e9fc126-d608-4e3c-b780-270ede29e4ee', name: '故宫博物院', startTime: '09:30', endTime: '13:30', category: '文化', cost: 50, lat: 39.917839, lng: 116.397029, coordSource: 'geocoded' },
          { id: '1cfaaf4a-6096-4857-b6b4-aa7a8a20d720', name: '景山公园', startTime: '14:00', endTime: '15:00', category: '自然', cost: 0, lat: 39.925875, lng: 116.396551, coordSource: 'geocoded' },
          { id: '5142507f-b5b3-4e18-8c11-388168159b7c', name: '王府井步行街', startTime: '15:45', endTime: '17:45', category: '购物', cost: 0, lat: 39.913479, lng: 116.412007, coordSource: 'geocoded' },
          { id: '9281ac89-895f-40a4-b79b-4b67066c7fb6', name: '四季民福烤鸭店(东四十条店)', startTime: '18:30', endTime: '20:00', category: '美食', cost: 146, lat: 39.933909, lng: 116.430109, coordSource: 'geocoded' },
        ],
        legs: [
          { fromActivityId: 'lodging', toActivityId: 'ee0a95f5-0e7b-46b7-8caa-e345713437de', mode: 'walk', durationMin: 18, distanceM: 1370, source: 'amap' },
          { fromActivityId: 'ee0a95f5-0e7b-46b7-8caa-e345713437de', toActivityId: '2e9fc126-d608-4e3c-b780-270ede29e4ee', mode: 'transit', durationMin: 47, distanceM: 3431, source: 'amap' },
          { fromActivityId: '2e9fc126-d608-4e3c-b780-270ede29e4ee', toActivityId: '1cfaaf4a-6096-4857-b6b4-aa7a8a20d720', mode: 'walk', durationMin: 19, distanceM: 1445, source: 'amap' },
          { fromActivityId: '1cfaaf4a-6096-4857-b6b4-aa7a8a20d720', toActivityId: '5142507f-b5b3-4e18-8c11-388168159b7c', mode: 'transit', durationMin: 34, distanceM: 3428, source: 'amap' },
          { fromActivityId: '5142507f-b5b3-4e18-8c11-388168159b7c', toActivityId: '9281ac89-895f-40a4-b79b-4b67066c7fb6', mode: 'transit', durationMin: 36, distanceM: 6105, source: 'amap' },
          { fromActivityId: '9281ac89-895f-40a4-b79b-4b67066c7fb6', toActivityId: 'lodging', mode: 'transit', durationMin: 31, distanceM: 7642, source: 'amap' },
        ],
      },
      {
        title: '古建与博物·天坛国博',
        activities: [
          { id: '109b7c6e-f6e5-4aa5-866d-75369f14357a', name: '天坛公园', startTime: '08:00', endTime: '10:00', category: '文化', cost: 15, lat: 39.881913, lng: 116.410829, coordSource: 'geocoded' },
          { id: 'd4e47afe-d6be-44ff-97cd-f6282aedde74', name: '中国国家博物馆', startTime: '11:00', endTime: '14:00', category: '文化', cost: 0, lat: 39.905374, lng: 116.401304, coordSource: 'geocoded' },
          { id: 'ae000133-63ba-406c-a20e-49674ac10040', name: '老北京炸酱面·烤鸭(前门店)', startTime: '14:30', endTime: '16:00', category: '美食', cost: 63, lat: 39.899767, lng: 116.392957, coordSource: 'geocoded' },
          { id: 'e2b2ff21-c32d-4e23-af0a-a7917359875e', name: '前门大街', startTime: '16:30', endTime: '17:30', category: '其他', cost: 0, lat: 39.896152, lng: 116.403895, coordSource: 'geocoded' },
        ],
        legs: [
          { fromActivityId: 'lodging', toActivityId: '109b7c6e-f6e5-4aa5-866d-75369f14357a', mode: 'transit', durationMin: 18, distanceM: 2799, source: 'heuristic' },
          { fromActivityId: '109b7c6e-f6e5-4aa5-866d-75369f14357a', toActivityId: 'd4e47afe-d6be-44ff-97cd-f6282aedde74', mode: 'transit', durationMin: 48, distanceM: 6900, source: 'amap' },
          { fromActivityId: 'd4e47afe-d6be-44ff-97cd-f6282aedde74', toActivityId: 'ae000133-63ba-406c-a20e-49674ac10040', mode: 'walk', durationMin: 18, distanceM: 1372, source: 'amap' },
          { fromActivityId: 'ae000133-63ba-406c-a20e-49674ac10040', toActivityId: 'e2b2ff21-c32d-4e23-af0a-a7917359875e', mode: 'walk', durationMin: 19, distanceM: 1422, source: 'heuristic' },
          { fromActivityId: 'e2b2ff21-c32d-4e23-af0a-a7917359875e', toActivityId: 'lodging', mode: 'walk', durationMin: 9, distanceM: 689, source: 'heuristic' },
        ],
      },
      {
        title: '长城豪情·八达岭全天',
        activities: [
          { id: '6f132bcf-00bd-4c37-8b78-26c00c567cc0', name: '八达岭长城', startTime: '09:00', endTime: '15:00', category: '自然', cost: 40, lat: 40.356188, lng: 116.016802, coordSource: 'geocoded' },
          { id: '4e2bba10-c937-4fe8-862a-d822332c9512', name: '南来顺饭庄', startTime: '18:00', endTime: '19:30', category: '美食', cost: 60, lat: 39.870908, lng: 116.354337, coordSource: 'geocoded' },
          { id: '487ffeb7-3765-49ab-b069-9fc170edaaed', name: '鸟巢·水立方夜景', startTime: '20:00', endTime: '21:00', category: '其他', cost: 0, lat: 39.992834, lng: 116.390397, coordSource: 'geocoded' },
        ],
        legs: [
          { fromActivityId: 'lodging', toActivityId: '6f132bcf-00bd-4c37-8b78-26c00c567cc0', mode: 'transit', durationMin: 264, distanceM: 84673, source: 'heuristic' },
          { fromActivityId: '6f132bcf-00bd-4c37-8b78-26c00c567cc0', toActivityId: '4e2bba10-c937-4fe8-862a-d822332c9512', mode: 'transit', durationMin: 267, distanceM: 85568, source: 'heuristic' },
          { fromActivityId: '4e2bba10-c937-4fe8-862a-d822332c9512', toActivityId: '487ffeb7-3765-49ab-b069-9fc170edaaed', mode: 'transit', durationMin: 68, distanceM: 19463, source: 'heuristic' },
          { fromActivityId: '487ffeb7-3765-49ab-b069-9fc170edaaed', toActivityId: 'lodging', mode: 'transit', durationMin: 55, distanceM: 14935, source: 'heuristic' },
        ],
      },
      {
        title: '皇家园林·颐和圆明',
        activities: [
          { id: 'e8f60255-4dfc-4d95-9c51-05dd82831b90', name: '颐和园', startTime: '08:30', endTime: '12:00', category: '自然', cost: 30, lat: 39.999617, lng: 116.275179, coordSource: 'geocoded' },
          { id: '9ee531a8-234a-45ab-88cb-3aeed7ee2a95', name: '圆明园遗址公园', startTime: '13:00', endTime: '16:00', category: '文化', cost: 25, lat: 40.006502, lng: 116.300875, coordSource: 'geocoded' },
          { id: '3669ff5a-a176-4ae5-a041-734b78ab36f3', name: '清真·鸦儿李记·涮肉(牛街店)', startTime: '18:00', endTime: '19:30', category: '美食', cost: 78, lat: 39.88493, lng: 116.363386, coordSource: 'geocoded' },
        ],
        legs: [
          { fromActivityId: 'lodging', toActivityId: 'e8f60255-4dfc-4d95-9c51-05dd82831b90', mode: 'transit', durationMin: 75, distanceM: 21691, source: 'heuristic' },
          { fromActivityId: 'e8f60255-4dfc-4d95-9c51-05dd82831b90', toActivityId: '9ee531a8-234a-45ab-88cb-3aeed7ee2a95', mode: 'transit', durationMin: 20, distanceM: 3246, source: 'heuristic' },
          { fromActivityId: '9ee531a8-234a-45ab-88cb-3aeed7ee2a95', toActivityId: '3669ff5a-a176-4ae5-a041-734b78ab36f3', mode: 'transit', durationMin: 71, distanceM: 20343, source: 'heuristic' },
          { fromActivityId: '3669ff5a-a176-4ae5-a041-734b78ab36f3', toActivityId: 'lodging', mode: 'transit', durationMin: 24, distanceM: 4574, source: 'heuristic' },
        ],
      },
      {
        title: '胡同烟火·恭王府与南锣',
        activities: [
          { id: '2e27bd99-c693-4d62-a398-9afe14061d5f', name: '恭王府博物馆', startTime: '08:30', endTime: '10:30', category: '文化', cost: 40, lat: 39.937222, lng: 116.386315, coordSource: 'geocoded' },
          { id: 'cfd09982-9138-4459-af48-5a31e5dbfe97', name: '什刹海', startTime: '10:45', endTime: '12:00', category: '自然', cost: 0, lat: 39.941893, lng: 116.385121, coordSource: 'geocoded' },
          { id: '1c7e6c26-bcc6-46bc-b323-94dece5e3533', name: '紫光园·烤鸭·北京菜(北京总店)', startTime: '12:45', endTime: '14:15', category: '美食', cost: 60, lat: 39.883533, lng: 116.364055, coordSource: 'geocoded' },
          { id: 'afed7d35-2264-4986-9add-56be3ed51c33', name: '南锣鼓巷', startTime: '15:00', endTime: '17:00', category: '其他', cost: 0, lat: 39.937182, lng: 116.402394, coordSource: 'geocoded' },
        ],
        legs: [
          { fromActivityId: 'lodging', toActivityId: '2e27bd99-c693-4d62-a398-9afe14061d5f', mode: 'transit', durationMin: 29, distanceM: 6409, source: 'heuristic' },
          { fromActivityId: '2e27bd99-c693-4d62-a398-9afe14061d5f', toActivityId: 'cfd09982-9138-4459-af48-5a31e5dbfe97', mode: 'walk', durationMin: 10, distanceM: 741, source: 'heuristic' },
          { fromActivityId: 'cfd09982-9138-4459-af48-5a31e5dbfe97', toActivityId: '1c7e6c26-bcc6-46bc-b323-94dece5e3533', mode: 'transit', durationMin: 38, distanceM: 9427, source: 'heuristic' },
          { fromActivityId: '1c7e6c26-bcc6-46bc-b323-94dece5e3533', toActivityId: 'afed7d35-2264-4986-9add-56be3ed51c33', mode: 'transit', durationMin: 39, distanceM: 9524, source: 'heuristic' },
          { fromActivityId: 'afed7d35-2264-4986-9add-56be3ed51c33', toActivityId: 'lodging', mode: 'transit', durationMin: 29, distanceM: 6262, source: 'heuristic' },
        ],
      },
    ],
  },
};

/** 固化快照 fixture → 等价 DraftTrip：活动 id 与 legs 原样保留（addActivity 生成的新 id 回写为快照 id 以维持 leg 关联） */
function draftFromBeijingSnapshot(): DraftTrip {
  const { form: snapForm, trip } = structuredClone(beijingSnapshot);
  const draft = new DraftTrip(snapForm);
  draft.setSkeleton(
    trip.title,
    trip.days.map((d) => d.title),
  );
  if (trip.lodging) {
    draft.setLodging(trip.lodging.name);
    draft.lodging!.lat = trip.lodging.lat;
    draft.lodging!.lng = trip.lodging.lng;
    draft.lodging!.coordSystem = trip.lodging.coordSystem;
  }
  const days = draft.mutableDays();
  trip.days.forEach((d, i) => {
    for (const a of d.activities) {
      draft.addActivity(i + 1, {
        name: a.name,
        startTime: a.startTime,
        endTime: a.endTime,
        category: a.category,
        cost: a.cost,
        lat: a.lat,
        lng: a.lng,
        coordSource: a.coordSource,
      });
    }
    days[i]!.activities.forEach((activity, j) => {
      activity.id = d.activities[j]!.id;
    });
    days[i]!.legs = structuredClone(d.legs ?? []);
  });
  return draft;
}

test('金标（beijing Day3）：夹具复现快照 3 个 hard，全部落在第 3 天', () => {
  const draft = draftFromBeijingSnapshot();
  const hard = draft.feasibility().violations.filter((v) => v.severity === 'hard');
  assert.equal(hard.length, 3);
  assert.ok(hard.every((v) => v.dayIndex === 3));
  assert.equal(hard.filter((v) => v.code === 'transit_infeasible').length, 2);
  assert.equal(hard.filter((v) => v.code === 'overpacked').length, 1);
});

test('金标（beijing Day3）：修复器把南来顺+鸟巢挪出第 3 天，修后 hard=0、活动总数不变', async () => {
  const draft = draftFromBeijingSnapshot();
  const idsBefore = allIds(draft);
  assert.equal(idsBefore.length, 19, '快照共 19 个活动');

  const { fn } = heuristicRecompute(draft);
  const fix = await repairLongHaulMixedDays(draft, { mode: 'transit', recomputeLegs: fn });

  // 混排市区活动全部挪出：八达岭独占第 3 天
  assert.deepEqual(dayNames(draft, 3), ['八达岭长城']);
  assert.equal(fix.applied.length, 2);
  // 目标天 = 按当时负载最轻：南来顺 → 第 5 天（末活动 17:00 + 通勤 45min → 18:00-19:30），
  // 鸟巢 → 第 2 天（末活动 17:30 + 通勤 55min → 18:30-19:30）；时长均保持原值
  const nanlaishun = draft.mutableDays()[4]!.activities.at(-1)!;
  assert.equal(nanlaishun.name, '南来顺饭庄');
  assert.equal(nanlaishun.startTime, '18:00');
  assert.equal(nanlaishun.endTime, '19:30');
  const niaochao = draft.mutableDays()[1]!.activities.at(-1)!;
  assert.equal(niaochao.name, '鸟巢·水立方夜景');
  assert.equal(niaochao.startTime, '18:30');
  assert.equal(niaochao.endTime, '19:30');

  assert.equal(hardCount(draft), 0, '修后整行程 hard=0');
  assert.deepEqual(allIds(draft), idsBefore, '只挪不删：活动 id 集不变（总数 19）');

  // 可信透明：采纳动作写成人话（经 verifiedFixNotes 校验后并入 reviewNotes 通道）
  assert.deepEqual(
    fix.applied.map((m) => ({ activityId: m.activityId, toDayIndex: m.toDayIndex })),
    [
      { activityId: nanlaishun.id, toDayIndex: 5 },
      { activityId: niaochao.id, toDayIndex: 2 },
    ],
  );
  assert.match(fix.applied[0]!.note, /系统自动调整：「南来顺饭庄」自第 3 天移至第 5 天/);
  assert.match(fix.applied[0]!.note, /「八达岭长城」/);
  assert.match(fix.applied[1]!.note, /系统自动调整：「鸟巢·水立方夜景」自第 3 天移至第 2 天/);
});

test('落库注记真话契约 verifiedFixNotes：修订轮推翻/删除被挪活动后，失真注记被过滤（live beijing stale-note 回归）', async () => {
  const draft = draftFromBeijingSnapshot();
  const { fn } = heuristicRecompute(draft);
  const fix = await repairLongHaulMixedDays(draft, { mode: 'transit', recomputeLegs: fn });
  assert.equal(fix.applied.length, 2);
  // 修复器刚跑完：全部注记为真，逐条保留且顺序不变
  assert.deepEqual(verifiedFixNotes(draft, fix.applied), fix.applied.map((m) => m.note));

  // 形态一（live beijing 实证）：修订轮规划师把被挪活动放回原天 → 该注记对最终行程为假话，须被过滤
  const nanlaishun = fix.applied.find((m) => m.note.includes('南来顺饭庄'))!;
  assert.ok(draft.moveActivityToDay(nanlaishun.toDayIndex, nanlaishun.activityId, 3), '模拟修订轮放回第 3 天');
  const afterOverride = verifiedFixNotes(draft, fix.applied);
  assert.equal(afterOverride.length, 1, '被推翻的挪动注记须被过滤（不对用户宣称不存在的调整）');
  assert.ok(afterOverride[0]!.includes('鸟巢·水立方夜景'), '仍成立的注记保留');

  // 形态二：被挪活动被审校删除（或重建换 id）→ 同样视为推翻
  const niaochao = fix.applied.find((m) => m.note.includes('鸟巢'))!;
  const targetDay = draft.mutableDays()[niaochao.toDayIndex - 1]!;
  targetDay.activities.splice(targetDay.activities.findIndex((a) => a.id === niaochao.activityId), 1);
  assert.deepEqual(verifiedFixNotes(draft, fix.applied), [], '活动不在目标天即弃注记');
});
