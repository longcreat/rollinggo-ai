// 路径折线抽稀（provider 中立）：把「lng,lat;lng,lat;…」坐标串等间隔采样压到上限之内。
// 09-25 从 integrations/amap/route.ts 抽出 —— 天地图适配层需要同一份逻辑，避免两处各写一遍。
const MAX_POLYLINE_CHARS = 4000;

/** 折线抽稀：等间隔取点压到 4000 字符内；仍超长则整体丢弃（回 undefined） */
export function downsamplePolyline(points: string[]): string | undefined {
  const clean = points.filter(Boolean);
  if (!clean.length) return undefined;
  // 单点约 20 字符（含分隔符），据此估算保留点数
  const keep = Math.max(2, Math.floor(MAX_POLYLINE_CHARS / 20));
  const step = Math.max(1, Math.ceil(clean.length / keep));
  const sampled = clean.filter((_, i) => i % step === 0 || i === clean.length - 1);
  const joined = sampled.join(';');
  return joined.length <= MAX_POLYLINE_CHARS ? joined : undefined;
}
