// 单测：长途点距离预计算（远郊编排层2 预防，node:test 经 tsx 运行）
// 覆盖：中位中心（奇/偶/空/单点）、分级阈值边界（59/60/89/90）、无坐标跳过、
// 点数不足防御、金标（北京快照真实坐标：八达岭须标强独占级、市区点不得误标）。
// 金标数字与 legs.test.ts 同源（金集快照 GCJ-02 坐标）；重调速度模型或阈值时有意识地更新。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LONG_HAUL_THRESHOLDS, type PoiCategory, type ResearchPoi } from '@tripweaver/shared';
import { MIN_LOCATED_POIS, classifyLongHaulPois, longHaulTier, medianCenter } from '../generation/longHaul';

function poi(name: string, category: PoiCategory = 'attraction'): ResearchPoi {
  return { id: name, name, category, intro: '', reservation: 'unknown', sourceLinks: [] };
}

// ---------- medianCenter：lat/lng 各自独立取中位数 ----------

test('medianCenter 奇数个点：lat/lng 各取中间值（两轴独立）', () => {
  const c = medianCenter([
    { lat: 1, lng: 30 },
    { lat: 2, lng: 10 },
    { lat: 3, lng: 20 },
  ]);
  assert.deepEqual(c, { lat: 2, lng: 20 });
});

test('medianCenter 偶数个点：取中间两值均值', () => {
  const c = medianCenter([
    { lat: 4, lng: 40 },
    { lat: 1, lng: 10 },
    { lat: 3, lng: 30 },
    { lat: 2, lng: 20 },
  ]);
  assert.deepEqual(c, { lat: 2.5, lng: 25 });
});

test('medianCenter 空数组返回 null，单点返回自身', () => {
  assert.equal(medianCenter([]), null);
  assert.deepEqual(medianCenter([{ lat: 39.9, lng: 116.4 }]), { lat: 39.9, lng: 116.4 });
});

// ---------- longHaulTier：阈值边界（59/60/89/90） ----------

test('longHaulTier 阈值边界：59 不标、60/89 长途级、90 强独占级', () => {
  assert.equal(longHaulTier(59), null);
  assert.equal(longHaulTier(60), 'longHaul');
  assert.equal(longHaulTier(89), 'longHaul');
  assert.equal(longHaulTier(90), 'exclusive');
});

test('longHaulTier 边界值与共享阈值常量一致（层2/层3 唯一事实源）', () => {
  assert.equal(longHaulTier(LONG_HAUL_THRESHOLDS.longHaulMin - 1), null);
  assert.equal(longHaulTier(LONG_HAUL_THRESHOLDS.longHaulMin), 'longHaul');
  assert.equal(longHaulTier(LONG_HAUL_THRESHOLDS.exclusiveMin - 1), 'longHaul');
  assert.equal(longHaulTier(LONG_HAUL_THRESHOLDS.exclusiveMin), 'exclusive');
});

// ---------- classifyLongHaulPois：防御路径 ----------

test('classify 空候选池返回空数组', () => {
  assert.deepEqual(classifyLongHaulPois([], new Map(), 'transit'), []);
});

test('classify 有坐标候选不足下限时整体不判定（两点互拉中心会误标）', () => {
  assert.ok(MIN_LOCATED_POIS >= 3, '下限须 ≥3（同 eval geo gate）');
  const pool = [poi('市区点'), poi('远郊点'), poi('无坐标点')];
  const locations = new Map([
    ['市区点', { lat: 39.9, lng: 116.4 }],
    ['远郊点', { lat: 40.36, lng: 116.02 }],   // 相距约 80km：两点中心居中，若判定则两者都会被误标
  ]);
  assert.deepEqual(classifyLongHaulPois(pool, locations, 'transit'), []);
});

test('classify 无坐标候选跳过标记（不猜坐标、不额外 geocode），市区簇不误标', () => {
  const pool = [poi('甲'), poi('乙'), poi('丙'), poi('远郊未定位点')];
  const locations = new Map([
    ['甲', { lat: 39.9, lng: 116.39 }],
    ['乙', { lat: 39.91, lng: 116.4 }],
    ['丙', { lat: 39.92, lng: 116.41 }],
    // 远郊未定位点：调研未命中坐标 → 跳过（漏标由层3 修复器兜底）
  ]);
  assert.deepEqual(classifyLongHaulPois(pool, locations, 'transit'), []);
});

// ---------- 金标：北京 5 日亲子快照真实坐标（GCJ-02，来自 eval/snapshots/beijing-5d-family.json） ----------
// 候选池 20 条中 14 条可由快照活动坐标关联（覆盖率 70%）；北海公园/部分餐馆/全部酒店无坐标 → 跳过。

const BEIJING_COORDS: Record<string, { lat: number; lng: number }> = {
  故宫博物院: { lat: 39.917839, lng: 116.397029 },
  天坛公园: { lat: 39.881913, lng: 116.410829 },
  颐和园: { lat: 39.999617, lng: 116.275179 },
  八达岭长城: { lat: 40.356188, lng: 116.016802 },
  恭王府博物馆: { lat: 39.937222, lng: 116.386315 },
  景山公园: { lat: 39.925875, lng: 116.396551 },
  圆明园遗址公园: { lat: 40.006502, lng: 116.300875 },
  中国国家博物馆: { lat: 39.905374, lng: 116.401304 },
  南锣鼓巷: { lat: 39.937182, lng: 116.402394 },
  '四季民福烤鸭店(东四十条店)': { lat: 39.933909, lng: 116.430109 },
  '清真·鸦儿李记·涮肉(牛街店)': { lat: 39.88493, lng: 116.363386 },
  '紫光园·烤鸭·北京菜(北京总店)': { lat: 39.883533, lng: 116.364055 },
  '老北京炸酱面·烤鸭(前门店)': { lat: 39.899767, lng: 116.392957 },
  南来顺饭庄: { lat: 39.870908, lng: 116.354337 },
};

const BEIJING_POOL: ResearchPoi[] = [
  ...Object.keys(BEIJING_COORDS).map((n) => poi(n, n.includes('店') || n === '南来顺饭庄' ? 'food' : 'attraction')),
  poi('北海公园'),                                  // 快照活动未含 → 无坐标
  poi('南门涮肉(马连道总店)', 'food'),
  poi('便宜坊烤鸭店(朝阳公园店)', 'food'),
  poi('桔子北京天安门广场王府井酒店', 'hotel'),
  poi('和颐至尚酒店(北京天安门王府井地铁站店)', 'hotel'),
  poi('北京新侨饭店', 'hotel'),
];

const BEIJING_LOCATIONS = new Map(Object.entries(BEIJING_COORDS));

test('金标：八达岭长城标为强独占级（估算公交单程 151min ≥90）', () => {
  const marks = classifyLongHaulPois(BEIJING_POOL, BEIJING_LOCATIONS, 'transit');
  const wall = marks.find((m) => m.name === '八达岭长城');
  assert.ok(wall, '八达岭长城必须被标记');
  assert.equal(wall.tier, 'exclusive');
  assert.equal(wall.durationMin, 151);   // 到候选池中位中心（前门-故宫一带）84.7km 段位的分段模型产物
});

test('金标：市区点不误标；颐和园/圆明园按西北远郊方向标长途级；结果按时长降序', () => {
  const marks = classifyLongHaulPois(BEIJING_POOL, BEIJING_LOCATIONS, 'transit');
  // 市区大部队（故宫/天坛/南锣鼓巷/前门餐馆…）与无坐标候选一律不出现
  assert.deepEqual(
    marks.map((m) => m.name),
    ['八达岭长城', '颐和园', '圆明园遗址公园'],
  );
  // 颐和园/圆明园同属西北方向 60-90min 段：长途级（当天须同方向顺路，快照原编排即两点同日）
  assert.equal(marks[1]!.tier, 'longHaul');
  assert.equal(marks[2]!.tier, 'longHaul');
  assert.ok(marks[1]!.durationMin >= 60 && marks[1]!.durationMin < 90);
  // 降序：最重的排最前，注入 prompt 时优先呈现
  assert.ok(marks[0]!.durationMin >= marks[1]!.durationMin && marks[1]!.durationMin >= marks[2]!.durationMin);
});

// ---------- fallbackCoords：知识库坐标兜底（09-23） ----------

// 北京真实坐标（GCJ-02）：市区三点 + 两个长城
const BJ = {
  gugong: { lat: 39.9163, lng: 116.3972 },
  tiantan: { lat: 39.8822, lng: 116.4066 },
  yonghegong: { lat: 39.947, lng: 116.4171 },
  badaling: { lat: 40.3598, lng: 116.0201 },   // 西北远郊 ~60km
  mutianyu: { lat: 40.4319, lng: 116.5703 },   // 东北远郊 ~70km
};

test('fallbackCoords：知识库来源候选无旁路坐标时，用兜底坐标参与标级', () => {
  const pool = [poi('故宫博物院'), poi('天坛公园'), poi('雍和宫'), poi('八达岭长城')];
  // 旁路只有市区三点（模拟 search_pois 只搜了市区），八达岭走知识库兜底
  const locations = new Map([
    ['故宫博物院', BJ.gugong],
    ['天坛公园', BJ.tiantan],
    ['雍和宫', BJ.yonghegong],
  ]);
  const fallback = new Map([['八达岭长城', BJ.badaling]]);
  const marks = classifyLongHaulPois(pool, locations, 'transit', fallback);
  const bdl = marks.find((m) => m.name === '八达岭长城');
  assert.ok(bdl, '八达岭应被标级（兜底坐标参与），实际未被标记');
  assert.equal(bdl.tier, 'exclusive', `八达岭应为强独占级，实际 ${bdl.tier}`);
});

test('fallbackCoords：旁路坐标优先于兜底（不覆盖已捕获值）', () => {
  const pool = [poi('故宫博物院'), poi('天坛公园'), poi('雍和宫'), poi('八达岭长城')];
  const locations = new Map([
    ['故宫博物院', BJ.gugong],
    ['天坛公园', BJ.tiantan],
    ['雍和宫', BJ.yonghegong],
    ['八达岭长城', BJ.gugong],  // 旁路捕到一个错误的市区坐标
  ]);
  const fallback = new Map([['八达岭长城', BJ.badaling]]);
  const marks = classifyLongHaulPois(pool, locations, 'transit', fallback);
  assert.equal(marks.find((m) => m.name === '八达岭长城'), undefined, '旁路坐标优先，错误坐标不应被兜底覆盖');
});
