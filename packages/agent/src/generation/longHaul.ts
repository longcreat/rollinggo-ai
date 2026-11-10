// 长途点距离情报的几何基元（远郊编排的公共底座，纯函数、无 IO、零外呼）。
// 参照点 = 候选池有坐标 POI 的坐标中位中心（lat/lng 各取中位数，代表「POI 主体/市区大部队」；
// 与 eval geo gate 的离群判定同构，城市无关）。标级逻辑由 geoSanity / longHaulFixer 各自消费。
// 阈值唯一事实源：LONG_HAUL_THRESHOLDS（@rollinggo-trip/shared）。

interface Coord {
  lat: number;
  lng: number;
}

/** 有坐标候选低于此数时整体不判定：点太少时中位中心会被离群点本身拖动而失真（同 eval geo gate 的 ≥3 下限） */
export const MIN_LOCATED_POIS = 3;

/** 一组数的中位数（偶数个取中间两值均值）；调用方保证非空 */
function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** 坐标中位中心：lat/lng 各取中位数（中位数抗单点离群，均值不行）；空数组返回 null */
export function medianCenter(points: readonly Coord[]): Coord | null {
  if (!points.length) return null;
  return { lat: median(points.map((p) => p.lat)), lng: median(points.map((p) => p.lng)) };
}
