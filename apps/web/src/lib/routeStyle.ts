// 行程路线的双层折线参数（AmapCanvas 与 LeafletCanvas 共用）。
//
// 单独立文件的原因：两套渲染必须画出同一种线，数值一旦在各自组件里硬编码就会漂移 ——
// 这正是 .trellis/spec/web/frontend/component-guidelines.md 里
// 「Map Rendering: Two Implementations Behind One Panel」要防的事。
//
// 数值出处：圆周旅迹（pitravel.cn）双层折线的实测记录，
// 见 .trellis/tasks/09-26-route-polyline-style/research/pitravel-route-style.md。
// 注意该文件里另记了一份「本地留存 chunk 与线上 build 的版本漂移」——以后要改数值先读它。

/**
 * 一条路线画两层：先底衬（更粗、压暗、无方向箭头），再主线（主色、有方向箭头，高德侧）。
 *
 * 分两档：`active` 是当前关注的天（未按天筛选时就是全部天），`faded` 是按天筛选后的其他天 ——
 * 它们仍然画在图上，只是整体压到几乎透明、并把 zIndex 降到当天之下。
 */
export const ROUTE_STROKE = {
  /** 底衬线宽（px） */
  underWeight: 7,
  /** 主线线宽（px） */
  mainWeight: 5,
  /** 底衬压暗比例，交给 `dimColor(hex, t)` */
  dim: 0.2,
  /** 当前关注的天：实色、高层 */
  active: { opacity: 0.88, underZIndex: 60, mainZIndex: 61 },
  /** 筛选后的非当天：淡化、低层（对齐圆周旅迹的 10/11 档） */
  faded: { opacity: 0.25, underZIndex: 10, mainZIndex: 11 },
} as const;
