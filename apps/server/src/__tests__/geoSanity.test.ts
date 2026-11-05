// 单测：geocodeAll 出口地理合理性校验（07-18 精准修复，node:test 经 tsx 运行）
// 覆盖：城市中心参照下异地错配拒绝 + warn（活动名/距离）、真实远郊（八达岭 60km 式）不误伤、
// 阈值 > 严格比较语义、参照点不可得跳过校验、城市中心失败退化中位中心互检、
// 前轮已采纳坐标入互检池（修订轮少量新点）、住宿条目同出口受检；
// 住宿专项阈值（50km）金标：live shanghai 同名近距错配（介于两阈值之间）被拦、市区住宿不误伤、两阈值互不干扰；
// 参照点互检（07-18 第 4 缺陷）金标：live chongqing 城市中心漂移 ~138km → 中位中心接管、解放碑住宿不冤杀，
// 城市中心正常时行为不变、中位池不足时城市中心直用。
// 金标坐标与 longHaul.test.ts 同源（金集快照 GCJ-02）；chengdu 案例即 live 实证的异地错配形态。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters } from '@tripweaver/shared';
import { MIN_LOCATED_POIS, medianCenter } from '../generation/longHaul';
import {
  GEOCODE_SANITY_MAX_KM,
  LODGING_SANITY_MAX_KM,
  REFERENCE_CONFLICT_KM,
  rejectFarGeocodes,
  type GeoSanityCheck,
} from '../generation/geoSanity';

const CHENGDU_CENTER = { lat: 30.657, lng: 104.0658 };     // 成都天府广场一带（城市级 geocode 参照）
const BEIJING_CENTER = { lat: 39.9042, lng: 116.4074 };
const BADALING = { lat: 40.356188, lng: 116.016802 };      // 八达岭长城：真实远郊 anchor（~60km）
const SHIJIAZHUANG = { lat: 38.0428, lng: 114.5149 };      // 异地错配代表点：距成都千余公里（同 live 实证量级）
const SHANGHAI_CENTER = { lat: 31.2304, lng: 121.4737 };   // 人民广场一带（城市级 geocode 参照）
// live shanghai 实证金标（快照 shanghai-3d-transit.json）：lodging「人民广场/南京路商圈」被同名错配到
// 嘉兴/海宁一带的「人民广场」——直线 ~108km（哨兵 leg 绕行系数后 ~151km/245min），恰落在两阈值之间
const LODGING_MISMATCH = { lat: 30.526379501093505, lng: 120.69163351492693 };
// live chongqing 实证金标（07-18 第 4 缺陷）：AMAP geocoder 挂 → 城市级 geocode 降级 Nominatim →
// 对行政区划返回市域几何中心（重庆市域 8.2 万 km²，几何中心在主城东北山区）→ 参照点漂移 ~138km，
// 主城全部正确坐标被判「距城市中心 ~138km」：住宿（50km）冤杀、活动（200km）侥幸存活
const CQ_JIEFANGBEI = { lat: 29.5531, lng: 106.5738 };     // 解放碑正确住宿坐标（live 日志原值，曾被冤杀）
const CQ_DRIFTED_CENTER = { lat: 30.06, lng: 107.87 };     // 市域几何中心一带（漂移参照点，距解放碑 ~137km）
const CQ_MAIN_CITY_ACTS: GeoSanityCheck[] = [              // 主城活动多数派：其中位中心即「用户行程所在的城市中心」
  { name: '洪崖洞', lat: 29.5628, lng: 106.5786 },
  { name: '磁器口古镇', lat: 29.5808, lng: 106.4433 },
  { name: '观音桥', lat: 29.5946, lng: 106.5333 },
  { name: '长江索道', lat: 29.5565, lng: 106.5844 },
];

function collectWarn(): { warns: string[]; warn: (msg: string) => void } {
  const warns: string[] = [];
  return { warns, warn: (msg) => warns.push(msg) };
}

test('校验常量契约：活动阈值 200km、住宿专项阈值 50km 更严、参照互检阈值 60km、中位互检池下限复用 longHaul 的 ≥3', () => {
  assert.equal(GEOCODE_SANITY_MAX_KM, 200);
  assert.equal(LODGING_SANITY_MAX_KM, 50);
  assert.equal(REFERENCE_CONFLICT_KM, 60);
  assert.ok(LODGING_SANITY_MAX_KM < GEOCODE_SANITY_MAX_KM, '住宿阈值须严于活动阈值（住宿不该远郊）');
  assert.ok(REFERENCE_CONFLICT_KM < GEOCODE_SANITY_MAX_KM, '互检阈值须严于活动阈值，否则漂移逼近活动阈值才被识破');
  assert.ok(MIN_LOCATED_POIS >= 3, '互检池下限须 ≥3（点太少中位中心被离群点拖动）');
});

test('城市中心参照：异地错配（>200km）被拒，warn 恰一条含活动名与距离；同批市内点通过', () => {
  const { warns, warn } = collectWarn();
  const checks: GeoSanityCheck[] = [
    { name: '小通巷', lat: 30.669, lng: 104.0554 },              // 市内 ~1.7km
    { name: '廖老妈蹄花', ...SHIJIAZHUANG },                     // 被 Nominatim 全球模糊匹配到异地
  ];
  const rejected = rejectFarGeocodes(checks, CHENGDU_CENTER, checks, warn);
  assert.deepEqual([...rejected], [1], '仅异地点被拒，市内点采纳');
  assert.equal(warns.length, 1, '每个被拒条目记且仅记一条 warn');
  const expectedKm = Math.round(haversineMeters(SHIJIAZHUANG, CHENGDU_CENTER) / 1000);
  assert.ok(expectedKm > 1000, `构造点须为跨省量级（实际 ${expectedKm}km）`);
  assert.ok(warns[0]!.includes('廖老妈蹄花'), 'warn 含活动名');
  assert.ok(warns[0]!.includes(`${expectedKm}km`), 'warn 含实际距离');
  assert.ok(warns[0]!.includes(`${GEOCODE_SANITY_MAX_KM}km`), 'warn 含阈值（拒绝原因）');
});

test('真实远郊 anchor 不误伤：八达岭距北京中心约 60km，远低于阈值，通过', () => {
  const { warns, warn } = collectWarn();
  const km = haversineMeters(BADALING, BEIJING_CENTER) / 1000;
  assert.ok(km > 50 && km < 70, `金标前提：八达岭 ~60km（实际 ${km.toFixed(1)}km）`);
  const rejected = rejectFarGeocodes([{ name: '八达岭长城', ...BADALING }], BEIJING_CENTER, [], warn);
  assert.equal(rejected.size, 0);
  assert.equal(warns.length, 0);
});

test('阈值语义为严格大于：~199km 通过、~201km 拒绝', () => {
  const reference = { lat: 30, lng: 104 };
  const near = { lat: 30 + 1.79, lng: 104 };   // 同经线 Δlat 1.79° ≈ 199km
  const far = { lat: 30 + 1.81, lng: 104 };    // ≈ 201km
  assert.ok(haversineMeters(near, reference) / 1000 < GEOCODE_SANITY_MAX_KM);
  assert.ok(haversineMeters(far, reference) / 1000 > GEOCODE_SANITY_MAX_KM);
  const rejected = rejectFarGeocodes(
    [
      { name: '阈内点', ...near },
      { name: '阈外点', ...far },
    ],
    reference,
    [],
    () => {},
  );
  assert.deepEqual([...rejected], [1]);
});

test('参照点不可得（无城市中心且互检池不足下限）：跳过校验保持现状，离群点也不拒、无 warn', () => {
  const { warns, warn } = collectWarn();
  const checks: GeoSanityCheck[] = [
    { name: '甲', lat: 30.66, lng: 104.06 },
    { name: '乙（离群）', ...BEIJING_CENTER },   // 两点相距 >1500km，但无参照即无从判定
  ];
  const rejected = rejectFarGeocodes(checks, null, checks.slice(0, MIN_LOCATED_POIS - 1), warn);
  assert.equal(rejected.size, 0, '防御：不因校验环节不可用而拦生成');
  assert.equal(warns.length, 0);
});

test('城市中心 geocode 失败 → 退化中位中心互检：多数市内点建立参照，异地点被拒', () => {
  const { warns, warn } = collectWarn();
  const checks: GeoSanityCheck[] = [
    { name: '宽窄巷子', lat: 30.6636, lng: 104.0554 },
    { name: '人民公园', lat: 30.6626, lng: 104.0555 },
    { name: '武侯祠', lat: 30.6432, lng: 104.0484 },
    { name: '春熙路', lat: 30.6552, lng: 104.0809 },
    { name: '廖老妈蹄花', ...SHIJIAZHUANG },   // 离群少数：中位数不被其拖动
  ];
  const rejected = rejectFarGeocodes(checks, null, checks, warn);
  assert.deepEqual([...rejected], [4], '互检拒异地点，市内多数通过');
  assert.equal(warns.length, 1);
  assert.ok(warns[0]!.includes('中位中心'), 'warn 标注参照来源为中位互检');
});

test('修订轮少量新点：前轮已采纳坐标入互检池，保住参照可得性', () => {
  const priorLocated = [
    { lat: 30.6636, lng: 104.0554 },
    { lat: 30.6626, lng: 104.0555 },
    { lat: 30.6432, lng: 104.0484 },
  ];
  const checks: GeoSanityCheck[] = [
    { name: '新增异地点', ...SHIJIAZHUANG },
    { name: '新增市内点', lat: 30.6552, lng: 104.0809 },
  ];
  // 新点仅 2 个（单独不足下限），合并前轮 3 个已采纳坐标后池=5 → 参照可得
  const rejected = rejectFarGeocodes(checks, null, [...priorLocated, ...checks], () => {});
  assert.deepEqual([...rejected], [0]);
});

test('住宿条目同出口受检（kind 标注走专项阈值）；池多数错配时互检接管的已知代价；空 checks 返回空集', () => {
  const { warns, warn } = collectWarn();
  // 住宿被解析到异地（>1500km，两档阈值均拦）：与活动同一出口、同一参照点降级链
  const lodgingOnly = rejectFarGeocodes(
    [{ name: '住宿 春熙路', ...BEIJING_CENTER, kind: 'lodging' }],
    CHENGDU_CENTER,
    [],
    warn,
  );
  assert.deepEqual([...lodgingOnly], [0]);
  assert.ok(warns[0]!.includes('住宿 春熙路'));
  assert.ok(warns[0]!.includes('住宿专项阈值'), 'warn 注明住宿专项阈值');
  // 互检的已知代价（构造反例，accepted tradeoff）：池内多数异地 → 中位中心本身被污染且与正确城市中心
  // 冲突 → 互检无法分辨谁真漂移、只能信多数派，正确城市中心被弃、市内点遭殃 —— 该场景 located 覆盖
  // 本就崩、eval geo gate 兜底（见 REFERENCE_CONFLICT_KM 常量注释）
  const majorityWrong = rejectFarGeocodes(
    [{ name: '市内点', lat: 30.66, lng: 104.06 }],
    CHENGDU_CENTER,
    [BEIJING_CENTER, BEIJING_CENTER, BEIJING_CENTER],
    () => {},
  );
  assert.equal(majorityWrong.size, 1, '多数派错配时中位中心接管（互检取多数，正确城市中心被弃）');
  assert.equal(rejectFarGeocodes([], CHENGDU_CENTER, [], warn).size, 0);
});

test('lodging 专项阈值金标（live shanghai）：同名近距错配（50-200km 之间）被拒，warn 注明专项阈值', () => {
  const { warns, warn } = collectWarn();
  const km = haversineMeters(LODGING_MISMATCH, SHANGHAI_CENTER) / 1000;
  // 金标前提：错配点恰落在两阈值之间——旧规则（统一 200km）放行、住宿专项阈值拦截；
  // 快照实证后果：放行 → 每天两段住宿哨兵 leg 各 ~245min → 三天全部 overpacked hard
  assert.ok(
    km > LODGING_SANITY_MAX_KM && km < GEOCODE_SANITY_MAX_KM,
    `金标前提：错配点介于 ${LODGING_SANITY_MAX_KM}-${GEOCODE_SANITY_MAX_KM}km（实际 ${km.toFixed(1)}km）`,
  );
  const rejected = rejectFarGeocodes(
    [{ name: '住宿 人民广场/南京路商圈', ...LODGING_MISMATCH, kind: 'lodging' }],
    SHANGHAI_CENTER,
    [],
    warn,
  );
  assert.deepEqual([...rejected], [0], '住宿近距同名错配被专项阈值拦截（走既有「有名无坐标」降级）');
  assert.equal(warns.length, 1);
  assert.ok(warns[0]!.includes('[geo-sanity]'), 'warn 沿用 [geo-sanity] 前缀');
  assert.ok(warns[0]!.includes('住宿专项阈值'), 'warn 注明住宿专项阈值');
  assert.ok(warns[0]!.includes(`${LODGING_SANITY_MAX_KM}km`), 'warn 含专项阈值数值');
});

test('正常市区 lodging（<10km）不误伤：城内商圈住宿通过专项阈值', () => {
  const { warns, warn } = collectWarn();
  const urbanLodging = { lat: 31.2353, lng: 121.4806 };   // 南京东路一带，距人民广场 ~1km
  const km = haversineMeters(urbanLodging, SHANGHAI_CENTER) / 1000;
  assert.ok(km < 10, `金标前提：市区住宿距城市中心 <10km（实际 ${km.toFixed(1)}km）`);
  const rejected = rejectFarGeocodes(
    [{ name: '住宿 南京东路商圈', ...urbanLodging, kind: 'lodging' }],
    SHANGHAI_CENTER,
    [],
    warn,
  );
  assert.equal(rejected.size, 0);
  assert.equal(warns.length, 0);
});

test('两阈值互不干扰：同一 50-200km 坐标，活动条目按 200km 通过、住宿条目按 50km 拒绝', () => {
  const checks: GeoSanityCheck[] = [
    { name: '远郊活动（同点）', ...LODGING_MISMATCH },                // 无 kind（活动）：~108km < 200km 通过
    { name: '住宿 同点', ...LODGING_MISMATCH, kind: 'lodging' },        // 住宿：~108km > 50km 拒绝
  ];
  const rejected = rejectFarGeocodes(checks, SHANGHAI_CENTER, [], () => {});
  assert.deepEqual([...rejected], [1], '同一坐标按条目类别分别适用阈值，活动阈值不被收紧');
});

test('参照点互检金标（live chongqing）：城市中心漂移 ~138km → 中位中心接管，解放碑住宿不再被冤杀', () => {
  const { warns, warn } = collectWarn();
  const median = medianCenter(CQ_MAIN_CITY_ACTS)!;
  // 金标前提①：漂移城市中心与活动中位中心冲突（>互检阈值）→ 互检必触发
  const conflictKm = haversineMeters(CQ_DRIFTED_CENTER, median) / 1000;
  assert.ok(conflictKm > REFERENCE_CONFLICT_KM, `金标前提：两参照点冲突 >${REFERENCE_CONFLICT_KM}km（实际 ${conflictKm.toFixed(1)}km）`);
  // 金标前提②：解放碑距漂移中心恰落在两阈值之间 —— 复现 live 形态（住宿被冤杀、活动侥幸存活）
  const lodgingDriftKm = haversineMeters(CQ_JIEFANGBEI, CQ_DRIFTED_CENTER) / 1000;
  assert.ok(
    lodgingDriftKm > LODGING_SANITY_MAX_KM && lodgingDriftKm < GEOCODE_SANITY_MAX_KM,
    `金标前提：解放碑距漂移中心介于 ${LODGING_SANITY_MAX_KM}-${GEOCODE_SANITY_MAX_KM}km（实际 ${lodgingDriftKm.toFixed(1)}km，live 实证 ~138km）`,
  );
  // 金标前提③：解放碑距中位中心仅 ~3km —— 中位中心接管后住宿必通过
  assert.ok(haversineMeters(CQ_JIEFANGBEI, median) / 1000 < LODGING_SANITY_MAX_KM, '金标前提：解放碑在活动主体附近');
  const checks: GeoSanityCheck[] = [
    ...CQ_MAIN_CITY_ACTS,
    { name: '住宿 解放碑/较场口区域', ...CQ_JIEFANGBEI, kind: 'lodging' },   // live 日志被冤杀的原条目
  ];
  const rejected = rejectFarGeocodes(checks, CQ_DRIFTED_CENTER, CQ_MAIN_CITY_ACTS, warn);
  assert.equal(rejected.size, 0, '互检生效（中位中心接管）：主城正确坐标含住宿全部通过，无冤杀');
  assert.equal(warns.length, 1, '参照点冲突记且仅记一条 warn（无任何拒绝 warn）');
  assert.ok(warns[0]!.includes('[geo-sanity]'), 'warn 沿用 [geo-sanity] 前缀');
  assert.ok(warns[0]!.includes('参照点冲突'), 'warn 说明冲突性质');
  assert.ok(
    warns[0]!.includes(`(${CQ_DRIFTED_CENTER.lat.toFixed(4)},${CQ_DRIFTED_CENTER.lng.toFixed(4)})`) &&
      warns[0]!.includes(`(${median.lat.toFixed(4)},${median.lng.toFixed(4)})`),
    'warn 含两参照点坐标',
  );
  assert.ok(warns[0]!.includes(`${Math.round(conflictKm)}km`), 'warn 含两参照点距离');
  assert.ok(warns[0]!.includes(`${REFERENCE_CONFLICT_KM}km`), 'warn 含互检阈值');
  assert.ok(warns[0]!.includes('改用中位中心'), 'warn 注明采用哪个参照点');
});

test('城市中心正常（与中位中心相距 < 互检阈值）：行为不变 —— 仍以城市中心为参照，无冲突 warn', () => {
  const { warns, warn } = collectWarn();
  // 成都市内多数派：中位中心距城市中心 ~2km，互检一致，不触发接管
  const pool = [
    { lat: 30.6636, lng: 104.0554 },
    { lat: 30.6626, lng: 104.0555 },
    { lat: 30.6432, lng: 104.0484 },
    { lat: 30.6552, lng: 104.0809 },
  ];
  assert.ok(
    haversineMeters(CHENGDU_CENTER, medianCenter(pool)!) / 1000 < REFERENCE_CONFLICT_KM,
    '金标前提：两参照点一致（<互检阈值）',
  );
  const checks: GeoSanityCheck[] = [
    { name: '市内点', lat: 30.66, lng: 104.06 },
    { name: '异地点', ...SHIJIAZHUANG },
  ];
  const rejected = rejectFarGeocodes(checks, CHENGDU_CENTER, pool, warn);
  assert.deepEqual([...rejected], [1], '异地点照拒、市内点照过（与互检引入前行为一致）');
  assert.equal(warns.length, 1, '仅异地拒绝 warn，无参照点冲突 warn');
  assert.ok(warns[0]!.includes('目的地城市中心'), '参照点仍为城市中心（未被互检接管）');
  assert.ok(!warns[0]!.includes('参照点冲突'));
});

test('互检不可得（中位池不足下限）：城市中心直用维持现状 —— 漂移场景冤杀仍发生（无更优信息，如实记录边界）', () => {
  const { warns, warn } = collectWarn();
  // 池仅 2 点（< MIN_LOCATED_POIS）：中位中心会被离群点本身拖动，不可作互检依据
  const pool = CQ_MAIN_CITY_ACTS.slice(0, MIN_LOCATED_POIS - 1).map((a) => ({ lat: a.lat, lng: a.lng }));
  const rejected = rejectFarGeocodes(
    [{ name: '住宿 解放碑/较场口区域', ...CQ_JIEFANGBEI, kind: 'lodging' }],
    CQ_DRIFTED_CENTER,
    pool,
    warn,
  );
  assert.deepEqual([...rejected], [0], '互检不可得时无从识别参照点漂移，城市中心直用（与旧行为一致）');
  assert.equal(warns.length, 1);
  assert.ok(warns[0]!.includes('目的地城市中心'), '拒绝 warn 的参照点标注为城市中心');
  assert.ok(!warns[0]!.includes('参照点冲突'), '不产生冲突 warn');
});
