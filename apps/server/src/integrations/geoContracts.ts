// 地图服务商中立契约：高德适配器实现（2026-11-05 起单轨）。
// 上层（geoPipeline / orchestrator / researchTools）只认这里的形状 —— 坐标系契约是 GCJ-02，
// 各适配器负责在调用外部服务前后自行做 WGS-84 ↔ GCJ-02 转换，上层感知不到 provider 差异。
// types only：本文件不引入任何 provider 实现，避免 geoProvider ↔ 适配器的循环依赖。
import type { LegMode, PoiCategory } from '@tripweaver/shared';
import type { SourceStatus } from './sourceStatus';

/** 经纬度点（本仓库内一律 GCJ-02，除非字段名显式说明） */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/** 地理编码结果点：坐标 + 行政区划码 */
export interface GeocodedPoint extends GeoPoint {
  adcode: string;
}

/** 解析链每级如实标注来源：amap-poi → amap-geocode → nominatim */
export type GeocodeOrigin = 'amap-poi' | 'amap-geocode' | 'nominatim';

export interface GeocodedPlace extends GeocodedPoint {
  origin: GeocodeOrigin;
}

export interface RouteEstimate {
  durationMin: number;
  distanceM: number;
  polyline?: string;   // 「lng,lat;lng,lat…」抽稀后串；超长丢弃仅留时长距离
}

export interface RouteOpts {
  city1?: string;   // 起点城市名/adcode（高德 transit 必需）
  city2?: string;   // 终点城市名/adcode（同上）
}

export interface RouteBreaker {
  /** 熔断是否已开启：开启后调用方可提前跳过 adcode 解析等前置准备 */
  isOpen(): boolean;
  /** 当前连续失败计数（成功清零；供日志与测试观测） */
  failStreak(): number;
  /**
   * 经熔断与额度闸门包装的路径规划。
   * @param tryAcquire 任务级 route 额度记账回调（拒绝则不发请求）；熔断开启时不调用 —— 没发请求就不扣额度。
   * 回 null 且不计失败的情形：熔断已开启 / 前置拦截（缺参数）/ 额度拒绝（三者均未发起真实请求）。
   */
  estimate(
    origin: GeoPoint,
    dest: GeoPoint,
    mode: LegMode,
    opts: RouteOpts,
    tryAcquire: () => boolean,
  ): Promise<RouteEstimate | null>;
}

/** 某个 provider 的地点记录：字段与高德 POI 2.0 对齐 */
export interface SourcedPoi {
  name: string;
  type: string;         // 最细一级分类，如「云南菜」
  address: string;
  rating: string;       // 评分（个人认证 Key 不返回 → 空串）
  cost: string;         // 人均消费（个人认证 Key 不返回 → 空串）
  opentime: string;     // 营业时间描述
  photoUrls: string[];  // 官方图片热链 ≤3
  location: GeoPoint | null;   // 坐标（GCJ-02；解析失败为 null）
  adcode: string;       // 行政区划码
}

export type PoiKind = 'amap' | 'null';

export interface PoiSource {
  readonly kind: PoiKind;
  searchPois(category: PoiCategory, keyword: string, region: string, signal?: AbortSignal): Promise<SourcedPoi[]>;
  selfCheck(): Promise<SourceStatus>;
}
