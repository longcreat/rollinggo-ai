// 地理工具（前后端共用）：WGS-84 ↔ GCJ-02 双向偏移算法 + Haversine 距离
// 确定性纯函数，无网络/环境依赖；中国境外坐标不偏移（outOfChina 判定为算法一部分）
// 反向 gcj02ToWgs84 于 09-25 新增：天地图用 CGCS2000（≈WGS-84），回写库前需转回 GCJ-02

const PI = Math.PI;
const A = 6378245.0;                 // 克拉索夫斯基椭球长半轴
const EE = 0.00669342162296594323;   // 偏心率平方

/** 粗判中国境外（标准 GCJ-02 算法附带的矩形判定，非精确国界） */
function outOfChina(lat: number, lng: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

/** WGS-84 → GCJ-02 正向偏移；境外坐标原样返回 */
export function wgs84ToGcj02(lat: number, lng: number): { lat: number; lng: number } {
  if (outOfChina(lat, lng)) return { lat, lng };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

/**
 * GCJ-02 → WGS-84 反向偏移；境外坐标原样返回。
 *
 * 正向偏移量随位置变化、无解析反函数，故用不动点迭代逼近：设 w 为 WGS-84 真值，
 * 每轮用 w -= (fwd(w) - gcj) 修正。正向映射的雅可比接近单位阵（偏移 ~0.005° 对位置的
 * 导数在 1e-3 量级），误差每轮缩小约三个数量级，3 轮即收敛到 1e-9 度量级（≈0.1mm），
 * 远优于本项目的米级需求。
 */
export function gcj02ToWgs84(lat: number, lng: number): { lat: number; lng: number } {
  if (outOfChina(lat, lng)) return { lat, lng };
  let wLat = lat;
  let wLng = lng;
  for (let i = 0; i < 3; i++) {
    const forward = wgs84ToGcj02(wLat, wLng);
    wLat -= forward.lat - lat;
    wLng -= forward.lng - lng;
  }
  return { lat: wLat, lng: wLng };
}

/** 球面直线距离（米），Haversine 公式 */
export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * PI) / 180;
  const dLng = ((b.lng - a.lng) * PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * PI) / 180) * Math.cos((b.lat * PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
