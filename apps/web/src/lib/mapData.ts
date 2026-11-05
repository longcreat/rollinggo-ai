// 地图数据层（09-26 抽出）：把「行程 → 可渲染的点与线」这段纯计算与具体地图 SDK 解耦，
// 供两套渲染共用（高德 JS API 优先，Leaflet 降级）。
// 坐标系：一律 GCJ-02 —— 高德 JS API 原生 GCJ-02，高德栅格瓦片也同系，故两套底图共用这里的坐标。
import { wgs84ToGcj02, type Activity, type TripDay } from '@tripweaver/shared';
import { dayColor, hasValidCoord } from './colors';
import { legForPair } from './tripDerive';

/**
 * 展示坐标（GCJ-02）。刻意用对象而不是 `[lat, lng]` 元组：
 * 高德收 `[lng, lat]`、Leaflet 收 `[lat, lng]`，元组顺序相反是经典 bug 源，对象无歧义。
 */
export interface GeoPos {
  lat: number;
  lng: number;
}

export interface MapPoint {
  day: TripDay;
  activity: Activity;
  order: number;
  pos: GeoPos;
  /** 当天主题色（两套渲染都要用它画 pin，故在数据层定好） */
  color: string;
  /** 按天筛选后属于非当天的点：仍然画出来，但整体淡化 */
  dimmed: boolean;
}

export interface LegSegment {
  key: string;
  positions: GeoPos[];
}

/** 一天的路线段 + 该天主题色 */
export interface DayLines {
  dayIndex: number;
  color: string;
  /** 按天筛选后属于非当天：路线仍然画出来，但整体淡化并降到当天之下 */
  dimmed: boolean;
  segments: LegSegment[];
}

/** 展示坐标统一到 GCJ-02：新数据（gcj02）直用，缺省 / wgs84（旧行程）正向偏移 */
export function displayPos(activity: Activity): GeoPos {
  if (activity.coordSystem === 'gcj02') return { lat: activity.lat, lng: activity.lng };
  return wgs84ToGcj02(activity.lat, activity.lng);
}

/** leg.polyline「lng,lat;lng,lat…」（GCJ-02）→ 点数组；坏点静默跳过 */
function parsePolyline(polyline: string): GeoPos[] {
  const points: GeoPos[] = [];
  for (const pair of polyline.split(';')) {
    const [lng, lat] = pair.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) points.push({ lat: lat!, lng: lng! });
  }
  return points;
}

/** 按天筛选时，非当天整体淡化；`highlightDay === null` 即「全部天」，没有淡化层 */
function isDimmed(dayIndex: number, highlightDay: number | null): boolean {
  return highlightDay !== null && dayIndex !== highlightDay;
}

/**
 * 当天路线段：仅画与当前相邻活动对匹配的 leg；无 leg / 失配的间隙不画线（旧行程整段无线）。
 * 无 polyline（heuristic / transit 估算段）降级为两点直连 —— 线型不再区分，靠左侧卡片的
 * 「估算」标签向用户交代；地图上统一实线。
 */
export function collectDayLines(days: TripDay[], highlightDay: number | null = null): DayLines[] {
  return days.map((day) => {
    const segments: LegSegment[] = [];
    for (let i = 1; i < day.activities.length; i += 1) {
      const from = day.activities[i - 1]!;
      const to = day.activities[i]!;
      if (!hasValidCoord(from) || !hasValidCoord(to)) continue;
      const leg = legForPair(day, from.id, to.id);
      if (!leg) continue;
      const path = leg.polyline ? parsePolyline(leg.polyline) : [];
      segments.push({
        key: `${from.id}:${to.id}`,
        positions: path.length >= 2 ? path : [displayPos(from), displayPos(to)],
      });
    }
    return {
      dayIndex: day.dayIndex,
      color: dayColor(day.dayIndex),
      dimmed: isDimmed(day.dayIndex, highlightDay),
      segments,
    };
  });
}

export function collectPoints(days: TripDay[], highlightDay: number | null = null): MapPoint[] {
  const points: MapPoint[] = [];
  for (const day of days) {
    let order = 0;
    for (const activity of day.activities) {
      order += 1;
      if (hasValidCoord(activity)) {
        points.push({
          day,
          activity,
          order,
          pos: displayPos(activity),
          color: dayColor(day.dayIndex),
          dimmed: isDimmed(day.dayIndex, highlightDay),
        });
      }
    }
  }
  return points;
}
