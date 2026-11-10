// 单测：通勤启发式分段速度模型（v0.6 估算修正，node:test 经 tsx 运行）
// 三档断言（市内段 / 跨分段点 / 长距离段）× transit + drive，另验 walk 不分段与单调性。
// 金标数字来自北京金集快照真实坐标（.trellis/tasks/07-18-beijing-hard-anchor 校准记录）：
// 重调速度模型时应有意识地更新这些金标，并复核 PRD 校准区间（八达岭段 120-200min）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEG_SPEED_MODEL, estimateTransit, haversineMeters } from '@tripweaver/shared';

// 北京金集快照 Day3 真实坐标（GCJ-02）
const LODGING = { lat: 39.897083, lng: 116.398254 };   // 前门-崇文门住宿锚点
const WALL = { lat: 40.356188, lng: 116.016802 };      // 八达岭长城（远郊，绕行 84.7km）
const NLS = { lat: 39.870908, lng: 116.354337 };       // 南来顺饭庄（市区）
const NEST = { lat: 39.992834, lng: 116.390397 };      // 鸟巢（市区，南来顺→鸟巢绕行 19.5km）

// 固定纬度上按目标直线距离构造点对（小角度下 haversine 对经度差近似线性，误差 <0.01%）
const P = { lat: 39.9, lng: 116.4 };
const M_PER_DEG_LNG = haversineMeters(P, { lat: P.lat, lng: P.lng + 1 });
const pairAtStraightM = (straightM: number) => [P, { lat: P.lat, lng: P.lng + straightM / M_PER_DEG_LNG }] as const;

// ---------- transit：市内段（≤分段点，估算须与旧单速模型一致） ----------

test('transit 市内段：南来顺→鸟巢（绕行 19.5km）维持 68min，不受长途提速影响', () => {
  const est = estimateTransit(NLS, NEST, 'transit');
  assert.equal(est.distanceM, 19463);
  assert.equal(est.durationMin, 68);   // 与快照存量一致：19.463/20*60+10
});

test('transit 市内段：鸟巢→住宿（绕行 14.9km）维持 55min', () => {
  const est = estimateTransit(NEST, LODGING, 'transit');
  assert.equal(est.durationMin, 55);
});

// ---------- transit：长距离段（城际/远郊，修正 2-3 倍高估） ----------

test('transit 长距离段：住宿→八达岭（绕行 84.7km）264→156min，落在 PRD 校准区间 120-200', () => {
  const est = estimateTransit(LODGING, WALL, 'transit');
  assert.equal(est.distanceM, 84673);
  assert.equal(est.durationMin, 156);
  assert.ok(est.durationMin >= 120 && est.durationMin <= 200, 'PRD 校准区间 120-200min');
});

test('transit 长距离段：八达岭→南来顺（绕行 85.6km）267→157min，独占日形态 2×单程+360min < 840min', () => {
  const est = estimateTransit(WALL, NLS, 'transit');
  assert.equal(est.durationMin, 157);
  const oneWay = estimateTransit(LODGING, WALL, 'transit').durationMin;
  assert.ok(oneWay * 2 + 360 < 840, `远郊独占日应可行且有余量（实际 ${oneWay * 2 + 360}min）`);
});

// ---------- 跨分段点：连续性（分段点两侧不跳变）与单调性 ----------

test('transit 跨分段点：分段点两侧 ±0.2km 时长差 ≤2min 且单调不减（连续）', () => {
  const fromM = LEG_SPEED_MODEL.transit.longHaul.fromKm * 1000;
  const below = estimateTransit(...pairAtStraightM((fromM - 200) / 1.4), 'transit');
  const above = estimateTransit(...pairAtStraightM((fromM + 200) / 1.4), 'transit');
  assert.ok(below.distanceM < fromM && above.distanceM > fromM, '构造点对须落在分段点两侧');
  assert.ok(above.durationMin >= below.durationMin, '时长须单调不减');
  assert.ok(above.durationMin - below.durationMin <= 2, `分段点两侧跳变 ${above.durationMin - below.durationMin}min`);
});

test('drive 跨分段点：分段点两侧 ±0.2km 时长差 ≤2min 且单调不减（连续）', () => {
  const fromM = LEG_SPEED_MODEL.drive.longHaul.fromKm * 1000;
  const below = estimateTransit(...pairAtStraightM((fromM - 200) / 1.4), 'drive');
  const above = estimateTransit(...pairAtStraightM((fromM + 200) / 1.4), 'drive');
  assert.ok(below.distanceM < fromM && above.distanceM > fromM, '构造点对须落在分段点两侧');
  assert.ok(above.durationMin >= below.durationMin, '时长须单调不减');
  assert.ok(above.durationMin - below.durationMin <= 2, `分段点两侧跳变 ${above.durationMin - below.durationMin}min`);
});

test('时长对距离全程单调不减（transit + drive，横跨分段点的距离扫描）', () => {
  const straights = [500, 2000, 5000, 10_000, 13_000, 14_300, 15_000, 20_000, 30_000, 50_000, 70_000];
  for (const mode of ['transit', 'drive'] as const) {
    let prev = 0;
    for (const s of straights) {
      const { durationMin } = estimateTransit(...pairAtStraightM(s), mode);
      assert.ok(durationMin >= prev, `${mode} 在直线 ${s}m 处时长 ${durationMin} < 前值 ${prev}`);
      prev = durationMin;
    }
  }
});

// ---------- drive：市内段维持 / 长距离段提速 ----------

test('drive 市内段：绕行 19.5km 维持旧模型 44min', () => {
  const est = estimateTransit(NLS, NEST, 'drive');
  assert.equal(est.durationMin, 44);   // 19.463/30*60+5，与旧单速模型一致
});

test('drive 长距离段：绕行 84.7km 174→100min（快速路/高速等效）', () => {
  const est = estimateTransit(LODGING, WALL, 'drive');
  assert.equal(est.durationMin, 100);
});

// ---------- walk：不分段（长途不提速），近距离维持 ----------

test('walk 不分段：绕行 84.7km 仍按 4.5km/h 全程计（无长途等效速度）', () => {
  const est = estimateTransit(LODGING, WALL, 'walk');
  assert.equal(est.durationMin, 1129);   // 84.673/4.5*60，若给 walk 加分段此金标会有意识地失败
});

test('walk 近距离：直线 1km（绕行 1.4km）≈19min 维持不变', () => {
  const est = estimateTransit(...pairAtStraightM(1000), 'walk');
  assert.equal(est.durationMin, 19);
});
