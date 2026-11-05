// 地图 marker 的 HTML（AmapCanvas 与 LeafletCanvas 共用）。
//
// 共用不是为了省这几行，而是为了不漂移：名称避让（lib/labelCollision.ts）靠
// `.map-marker` / `.marker-pin` / `.map-label` 三个类名找元素，两套渲染一旦各写各的 HTML，
// 避让就会在其中一套上静默失效 —— 而失效的样子只是「名字不避让」，很容易被当成没做。
//
// marker DOM 契约（改这里时不要顺手删类名）：
//   .map-marker                 28×28 定位框，relative；避让的查询起点
//     .marker-pin               编号圆形 pin，绝对居中
//     .map-label                名称文本，绝对定位在 pin 下方，不参与命中
//   .map-marker--dimmed         按天筛选后被淡化的整天 marker

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** 活动名 / 简介来自模型输出，拼进 HTML 前必须转义（marker 走 innerHTML） */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

export interface MarkerHtmlInput {
  color: string;
  order: number;
  /** 坐标为估算：pin 走虚线边框 + 降透明度（`.marker-estimated`） */
  estimated: boolean;
  /** 按天筛选后非当天 */
  dimmed: boolean;
  label: string;
}

export function markerHtml({ color, order, estimated, dimmed, label }: MarkerHtmlInput): string {
  return [
    `<div class="${escapeHtml(`map-marker relative [width:28px] [height:28px]${dimmed ? " map-marker--dimmed [opacity:0.3]" : ""}`)}">`,
    `<div class="${escapeHtml(`marker-pin [width:28px] [height:28px] [border-radius:50%] [color:var(--color-btn-primary-color-3)] [font-size:0.82rem] font-bold flex items-center justify-center [border:2px_solid_var(--color-btn-primary-color-3)] [box-shadow:0_1px_4px_rgba(0,_0,_0,_0.35)]${estimated ? " marker-estimated [border-style:dashed] [opacity:0.85]" : ""}`)}" style="background:${color}">${order}</div>`,
    `<div class="${escapeHtml("map-label absolute [top:100%] [left:50%] [transform:translateX(-50%)] [margin-top:2px] whitespace-nowrap [font-size:0.72rem] font-semibold [color:var(--color-map-label-color-10)] [text-shadow:0_0_3px_var(--color-btn-primary-color-3),_0_0_2px_var(--color-btn-primary-color-3)] pointer-events-none [&.map-label--hidden]:invisible")}">${escapeHtml(label)}</div>`,
    '</div>',
  ].join('');
}
