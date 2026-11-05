// POI 名称标签的避让（SDK-free，两套渲染共用）。
//
// 做法对齐圆周旅迹：把「pin + 名称」合并成一个占位框，按顺序先到先得，
// 与任一已占位框相交的名称就隐藏。不做实时推挤、也不做 rAF 循环 ——
// 调用方只在 zoomend / moveend 与覆盖物重建后各跑一次，交互结束才算一次，
// 因此不存在阈值抖动，也就不需要圆周旅迹那套迟滞阈值。
//
// ⚠️ 本模块只认类名 `.map-marker` / `.marker-pin` / `.map-label`，
// 不依赖任何地图 SDK 的 DOM 结构。所以 marker HTML 必须带上这些类
// （见 components/editor/markerHtml.ts）—— 删类名等于关掉避让。

/** 低于此 zoom 整层名称隐藏。本项目一次框选整段行程，城市级缩放约为 11–13 */
const LABEL_MIN_ZOOM = 9;
/** 占位框的额外膨胀像素，让名称之间留出呼吸而不是紧贴 */
const LABEL_GAP = 2;

const HIDDEN = 'map-label--hidden';

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** 严格相交；贴边不算（与圆周旅迹的判据一致） */
function overlaps(a: Rect, b: Rect): boolean {
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
}

function union(rects: Rect[]): Rect | null {
  const valid = rects.filter((r) => r.width > 0 && r.height > 0);
  if (valid.length === 0) return null;
  const left = Math.min(...valid.map((r) => r.left));
  const top = Math.min(...valid.map((r) => r.top));
  const right = Math.max(...valid.map((r) => r.right));
  const bottom = Math.max(...valid.map((r) => r.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function padded(rect: Rect): Rect {
  return {
    left: rect.left - LABEL_GAP,
    top: rect.top - LABEL_GAP,
    right: rect.right + LABEL_GAP,
    bottom: rect.bottom + LABEL_GAP,
    width: rect.width + LABEL_GAP * 2,
    height: rect.height + LABEL_GAP * 2,
  };
}

/**
 * 就地切换每个名称标签的可见性。
 *
 * 隐藏用 `visibility: hidden` 而不是 `display: none`：前者仍占位、仍能测出 rect，
 * 所以每轮都可以从零重算，不需要先复原再测量的两步走。
 */
export function resolveLabelCollisions(host: HTMLElement, zoom: number): void {
  const labels = Array.from(host.querySelectorAll<HTMLElement>('.map-label'));
  if (labels.length === 0) return;

  if (!Number.isFinite(zoom) || zoom < LABEL_MIN_ZOOM) {
    for (const label of labels) label.classList.add(HIDDEN);
    return;
  }

  // 非淡化（当前天）先占位，淡化层让位；同层内顺序即 DOM 顺序（= 活动顺序），
  // 依赖 Array.prototype.sort 的稳定性。
  const markers = Array.from(host.querySelectorAll<HTMLElement>('.map-marker')).sort(
    (a, b) => Number(a.classList.contains('map-marker--dimmed')) - Number(b.classList.contains('map-marker--dimmed')),
  );

  const placed: Rect[] = [];
  for (const marker of markers) {
    const label = marker.querySelector<HTMLElement>('.map-label');
    const pin = marker.querySelector<HTMLElement>('.marker-pin');
    if (!label || !pin) continue;

    // pin 尚未上屏时 rect 全为 0，跳过而不是误判成「不冲突」
    const box = union([pin.getBoundingClientRect(), label.getBoundingClientRect()]);
    if (!box) {
      label.classList.add(HIDDEN);
      continue;
    }

    const rect = padded(box);
    if (placed.some((other) => overlaps(other, rect))) {
      label.classList.add(HIDDEN);
    } else {
      label.classList.remove(HIDDEN);
      placed.push(rect);
    }
  }
}
