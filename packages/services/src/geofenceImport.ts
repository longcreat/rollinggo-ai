// 景区围栏的细分点位导入：把「片区检索」拿到的 POI 过滤成可编排的景点。
//
// 高德会返回售票亭、码头、停车场、游客中心这类设施点；它们不是景点，进入日程会
// 让路线看起来真实但没有可玩性（实测「花港码头售票亭」被排成一天的一站）。
// 这里只做纯函数判定与行构造，DB 去重所需的历史键由调用方传入，便于单测。
import { createHash } from 'node:crypto';
import { haversineMeters } from '@rollinggo-trip/shared';
import type { GeoPoint, SourcedPoi } from '@rollinggo-trip/integrations/geoContracts';

export const SUB_POI_SOURCE = 'amap-area';

export interface SubPoiPolicy {
  /** 子点距片区中心的最大距离；大型湖泊可放宽到 5–6km。 */
  maxDistanceM: number;
  /** 设施类名称（不是景点）。 */
  nameBlacklist: RegExp;
  /** 设施类 POI 类型。 */
  typeBlacklist: RegExp;
}

export const DEFAULT_SUB_POI_POLICY: SubPoiPolicy = {
  maxDistanceM: 5_000,
  nameBlacklist: /售票|码头|停车场|入口|出口|检票|游客中心|服务中心|服务点|咨询|厕所|公厕|便利店|ATM|银行|加油站|充电站|驿站|停车场|停车|驿站|门市部|售票处|管理处|派出所|警务|售票亭/,
  typeBlacklist: /停车场|停车|交通设施|出入口|公共厕所|厕所|银行|ATM|加油站|充电站|收费站|公交|地铁|服务区|道路附属|通行设施|道路|门禁|岗亭/,
};

export type SubPoiRejection =
  | 'no-name'
  | 'no-location'
  | 'blacklisted-name'
  | 'blacklisted-type'
  | 'too-far'
  | 'duplicate-coordinate'
  | 'duplicate-name';

export interface SubPoiRow {
  id: string;
  city: string;
  name: string;
  category: string;
  lng: number;
  lat: number;
  source: string;
  verified: boolean;
  payload: Record<string, unknown>;
  parentId: string;
  geomKind: 'point';
  dedupeKey: string;
}

export interface SubPoiReport {
  accepted: number;
  rejected: Record<SubPoiRejection, number>;
  samples: { name: string; reason: SubPoiRejection }[];
}

/** 约 11m 网格：同格视为同一坐标（高德对同一地物偶尔返回多行）。 */
export function coordinateKey(point: GeoPoint): string {
  return `${point.lng.toFixed(4)}|${point.lat.toFixed(4)}`;
}

export function placeIdFor(city: string, name: string): string {
  return createHash('sha256').update(`${city}|${name.trim()}`).digest('hex').slice(0, 32);
}

/** 单个点位是否可作为该片区的“可编排景点”。 */
export function classifySubPoi(
  poi: SourcedPoi,
  parent: { center: GeoPoint | null },
  policy: SubPoiPolicy = DEFAULT_SUB_POI_POLICY,
): SubPoiRejection | null {
  const name = poi.name.trim();
  if (!name) return 'no-name';
  if (policy.nameBlacklist.test(name)) return 'blacklisted-name';
  if (policy.typeBlacklist.test(poi.type)) return 'blacklisted-type';
  if (!poi.location) return 'no-location';
  if (parent.center && haversineMeters(parent.center, poi.location) > policy.maxDistanceM) return 'too-far';
  return null;
}

export function emptyReport(): SubPoiReport {
  return {
    accepted: 0,
    rejected: { 'no-name': 0, 'no-location': 0, 'blacklisted-name': 0, 'blacklisted-type': 0, 'too-far': 0, 'duplicate-coordinate': 0, 'duplicate-name': 0 },
    samples: [],
  };
}

/**
 * 把片区检索结果转成可 upsert 的行。
 * 去重维度：坐标网格（city 内）与名称（city 内，含已有点位）。
 */
export function buildSubPoiRows(input: {
  city: string;
  parentId: string;
  parentCenter: GeoPoint;
  pois: readonly SourcedPoi[];
  /** 该城市已有的 dedupe_key（含库内其他片区）。 */
  existingCoordKeys?: Iterable<string>;
  /** 该城市已有的地点名（归一化）。 */
  existingNames?: Iterable<string>;
  policy?: SubPoiPolicy;
}): { rows: SubPoiRow[]; report: SubPoiReport } {
  const policy = input.policy ?? DEFAULT_SUB_POI_POLICY;
  const coordKeys = new Set(input.existingCoordKeys ?? []);
  const names = new Set([...(input.existingNames ?? [])].map(normalizeName));
  const rows: SubPoiRow[] = [];
  const report = emptyReport();
  for (const poi of input.pois) {
    const rejection = classifySubPoi(poi, { center: input.parentCenter }, policy);
    if (rejection) { report.rejected[rejection] += 1; pushSample(report, poi.name, rejection); continue; }
    const location = poi.location!;
    const dedupeKey = coordinateKey(location);
    if (coordKeys.has(dedupeKey)) { report.rejected['duplicate-coordinate'] += 1; pushSample(report, poi.name, 'duplicate-coordinate'); continue; }
    const name = poi.name.trim();
    if (names.has(normalizeName(name))) { report.rejected['duplicate-name'] += 1; pushSample(report, poi.name, 'duplicate-name'); continue; }
    coordKeys.add(dedupeKey);
    names.add(normalizeName(name));
    rows.push({
      id: placeIdFor(input.city, name),
      city: input.city,
      name,
      category: 'attraction',
      lng: location.lng,
      lat: location.lat,
      source: SUB_POI_SOURCE,
      verified: true,
      payload: {
        type: poi.type,
        address: poi.address,
        opentime: poi.opentime,
        ...(poi.rating ? { rating: poi.rating } : {}),
        ...(poi.photoUrls.length ? { photos: poi.photoUrls.map((url) => ({ url })), coverImage: poi.photoUrls[0] } : {}),
        parentPlaceId: input.parentId,
        areaImport: true,
      },
      parentId: input.parentId,
      geomKind: 'point',
      dedupeKey,
    });
    report.accepted += 1;
  }
  return { rows, report };
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '');
}

function pushSample(report: SubPoiReport, name: string, reason: SubPoiRejection) {
  if (report.samples.length < 10) report.samples.push({ name, reason });
}
