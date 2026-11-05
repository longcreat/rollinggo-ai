// 地理合理性校验（07-18 精准修复）：geocodeAll 出口对解析结果统一做「距目的地参照点」检查。
// 实证根因（live chengdu）：AMAP geocoder 间歇失败 → 降级 Nominatim → 中文小 POI 全球模糊匹配
// 返回异地坐标（实测两个市内点被拉开 ~1180km），geocodeAll 无校验直接采纳 → 算出 37h 通勤污染行程。
// 危害排序：错误坐标 >> 无坐标 —— 无坐标只降 located 覆盖、geo gate 能兜；错坐标产生幻觉行程。
// 第二实证（live shanghai，07-18）：lodging「人民广场/南京路商圈」被同名错配到嘉兴/海宁一带
// （直线 ~108km，低于活动阈值漏网）→ 住宿哨兵 leg 每天成对出现（~245min×2），三天全部 overpacked hard。
// 故按条目类别区分阈值：住宿锚点适用更严的 LODGING_SANITY_MAX_KM，活动阈值维持不变。
// 第三实证（live chongqing，07-18）：参照点自身漂移的冤杀形态 —— AMAP 挂时城市级 geocode 同样降级
// Nominatim，后者对行政区划返回市域几何中心（重庆距解放碑 ~138km）→ 主城正确坐标反被判异地弃用。
// 故参照点也要互检：城市中心与活动中位中心相距超 REFERENCE_CONFLICT_KM 时弃前者用后者。
// 原则：校验只拒不改 —— 不试图「纠正」坐标，拒绝即视同解析失败（宁缺毋错）；
// 对 AMAP 与 Nominatim 两条路径的结果统一校验，与来源无关；参照点不可得时跳过校验（防御：不因校验挂掉生成）。
import { haversineMeters } from '@tripweaver/shared';
import { MIN_LOCATED_POIS, medianCenter } from './longHaul';

/** 解析结果距参照点（目的地城市中心/已解析坐标中位中心）超此值判为解析失败，弃用坐标（活动条目
 *  阈值；住宿锚点另有更严的 LODGING_SANITY_MAX_KM）。
 *  200km 取值理由：真实远郊 anchor（八达岭 60km、崂山 35km、兵马俑 35km）远低于此，不误伤；
 *  跨省错配（chengdu 实测 ~1180km）必被拦；超大市域（重庆全域 ~230km）有极小理论误伤可能，
 *  当前生成以主城为单位可接受，常量可调。纯生产防线（server 侧），eval 不消费。 */
export const GEOCODE_SANITY_MAX_KM = 200;

/** 住宿锚点专项阈值。语义理由：住宿锚点=市区商圈/城内区域，50km 已覆盖超大城市主城直径；活动可远郊
 *  （八达岭 60km 式 anchor）所以 200km，住宿不该远郊。错拒代价仅为退化到「有名无坐标」的既有降级
 *  路径（anchor_missing soft + 不生成住宿哨兵 leg），远低于错配代价——错配的住宿 leg 每天成对出现，
 *  被 ×2×天数放大：live shanghai 实证 ~150km 级同名错配（直线 ~108km，恰落在两阈值之间漏网）
 *  造成三天全部 overpacked hard。 */
export const LODGING_SANITY_MAX_KM = 50;

/** 参照点互检阈值：城市中心与已解析坐标中位中心同时可得且相距超此值时，判城市中心可疑，
 *  弃用改取中位中心作参照。理由：城市 geocode 正确时应落在活动主体附近 —— 活动主体本身就
 *  定义了「用户行程所在的城市中心」；60km 覆盖主城正常半径，超出即参照点漂移。中位数抗少数
 *  离群污染，多数活动正确时它比漂移的城市中心更可信；活动大面积错配时两参照点都不可信，
 *  但该场景 located 覆盖本就崩、eval geo gate 兜底。
 *  实证（live chongqing，07-18）：AMAP geocoder 挂 → 城市级 geocode 降级 Nominatim → 对行政
 *  区划返回市域几何中心（重庆市域 8.2 万 km²，几何中心在主城东北山区，距解放碑 ~138km）→
 *  主城全部正确坐标「距城市中心 ~138km」→ 住宿（50km 专项阈值）被冤杀。任何大市域城市
 *  （哈尔滨/大理/丽江等）城市 geocode 走到 Nominatim 时同理复现。 */
export const REFERENCE_CONFLICT_KM = 60;

interface Coord {
  lat: number;
  lng: number;
}

/** 待校验的解析结果条目（活动/住宿锚点）；name 仅用于 warn 日志定位；
 *  kind 决定适用阈值：'lodging' 用 LODGING_SANITY_MAX_KM，缺省（活动）用 GEOCODE_SANITY_MAX_KM */
export interface GeoSanityCheck {
  name: string;
  lat: number;
  lng: number;
  kind?: 'activity' | 'lodging';
}

/**
 * 出口校验：返回 checks 中应拒绝（弃用坐标）条目的下标集合。
 * 阈值按条目 kind 区分（活动 GEOCODE_SANITY_MAX_KM / 住宿 LODGING_SANITY_MAX_KM）；参照点降级链两类共用：
 *  ① cityCenter —— 目的地城市级 geocode 坐标（城市名解析成功率最高）；但其自身可能漂移
 *     （降级 Nominatim 时行政区划返回市域几何中心，live chongqing 实证），故与 ② 同时可得时
 *     先互检：相距 > REFERENCE_CONFLICT_KM 判 ① 可疑，改用 ②（理由见常量注释）；
 *  ② 中位中心 —— medianPool（已解析活动坐标：前轮已校验采纳的 + 本次暂存的）的坐标中位数，
 *     中位数抗少数离群；但点数 < MIN_LOCATED_POIS 时中位中心会被离群点本身拖动（同 longHaul/
 *     eval geo gate 的 ≥3 下限），视为不可得 —— 此时互检也不可得，① 直用维持现状；
 *  ③ 两者皆不可得 → 返回空集（跳过校验保持现状，不因校验环节挂掉生成）。
 */
export function rejectFarGeocodes(
  checks: readonly GeoSanityCheck[],
  cityCenter: Coord | null,
  medianPool: readonly Coord[],
  warn: (msg: string) => void = console.warn,
): Set<number> {
  const rejected = new Set<number>();
  if (!checks.length) return rejected;
  // 参照点②：池不足 MIN_LOCATED_POIS 时中位中心会被离群点本身拖动而失真，视为不可得
  const median = medianPool.length >= MIN_LOCATED_POIS ? medianCenter(medianPool) : null;
  let reference = cityCenter ?? median;
  let refLabel = cityCenter ? '目的地城市中心' : '已解析坐标中位中心';
  if (!reference) return rejected;
  // 参照点互检（07-18 第 4 缺陷修复）：两参照点同时可得且相距超互检阈值 → 城市中心疑似漂移
  // （大市域几何中心等），弃用改取中位中心；互检不可得（中位池不足）时城市中心直用维持现状
  if (cityCenter && median) {
    const conflictKm = haversineMeters(cityCenter, median) / 1000;
    if (conflictKm > REFERENCE_CONFLICT_KM) {
      reference = median;
      refLabel = '已解析坐标中位中心';
      warn(
        `[geo-sanity] 参照点冲突：目的地城市中心 (${cityCenter.lat.toFixed(4)},${cityCenter.lng.toFixed(4)}) 与已解析坐标中位中心 (${median.lat.toFixed(4)},${median.lng.toFixed(4)}) 相距约 ${Math.round(conflictKm)}km（互检阈值 ${REFERENCE_CONFLICT_KM}km），城市中心疑似漂移（如大市域几何中心），改用中位中心作参照点`,
      );
    }
  }
  // forEach 闭包内 let 的非空收窄会失效，参照点定稿后快照为 const 供循环使用
  const ref = reference;
  checks.forEach((item, i) => {
    // 阈值按条目类别区分：住宿锚点专项更严（近距同名错配也要拦），活动维持原阈值
    const isLodging = item.kind === 'lodging';
    const maxKm = isLodging ? LODGING_SANITY_MAX_KM : GEOCODE_SANITY_MAX_KM;
    const km = haversineMeters(item, ref) / 1000;
    if (km > maxKm) {
      rejected.add(i);
      // 生成会话层无 Fastify logger 可达（同 route 熔断先例）：单行 warn 供运维定位坐标弃用根因，无敏感信息
      warn(
        `[geo-sanity] 「${item.name}」解析坐标 (${item.lat.toFixed(4)},${item.lng.toFixed(4)}) 距${refLabel}约 ${Math.round(km)}km（${isLodging ? '住宿专项阈值' : '阈值'} ${maxKm}km），判为异地错配，弃用该坐标（视同解析失败）`,
      );
    }
  });
  return rejected;
}
