import { DAY_COLORS, type ActivityCategory } from '@tripweaver/shared';

export function dayColor(dayIndex: number): string {
  return DAY_COLORS[(dayIndex - 1) % DAY_COLORS.length]!;
}

export const CATEGORY_COLORS: Record<ActivityCategory, string> = {
  美食: '#e76f51',
  文化: '#457b9d',
  自然: '#2a9d8f',
  购物: '#b5838d',
  住宿: '#6d597a',
  交通: '#8d99ae',
  娱乐: '#d9a406',
  其他: '#8a8f98',
};

/**
 * 底衬色：把主色整体压暗一档（RGB 三段各乘 `1 - t`）。
 * 用途是地图路线的双层折线 —— 同一路段先画更粗的暗色底衬、再画主色主线，让线在底图上有描边感。
 * 非 `#RRGGBB` 输入原样返回：宁可少一层底衬，也不要算出 `rgb(NaN,NaN,NaN)` 把线画成不可见。
 */
export function dimColor(hex: string, t = 0.2): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.round(r * (1 - t))},${Math.round(g * (1 - t))},${Math.round(b * (1 - t))})`;
}

export function hasValidCoord(a: { lat: number; lng: number }): boolean {
  return Number.isFinite(a.lat) && Number.isFinite(a.lng) && !(a.lat === 0 && a.lng === 0);
}
