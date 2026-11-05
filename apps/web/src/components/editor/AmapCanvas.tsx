// 高德 JS API 渲染（09-26 新增，**主路径**）：与 LeafletCanvas 共用 lib/mapData 的点与线。
//
// ⚠️ 本文件存在的全部目的在这里一行：`features` 只给 ['bg','road','building']，**不给 'point'**。
// `point` 才是兴趣点与文字标注层 —— 栅格瓦片把文字烘焙进 PNG（`style=` 关不掉，CSS 滤镜试过并回滚
// 于 commit 1d5a59b），JS API 能按图层精确控制，这是换渲染器唯一的收益来源。
//
// 交互：点 marker 不再弹气泡，直接让中间行程栏跳转到对应景点（回调见 Props.onSelectActivity，
// 由 MapView 从 TripEditorPage 传入）。
//
// 路线是双层折线（参数见 lib/routeStyle），marker 带名称标签（HTML 见 lib/markerHtml），
// 标签避让见 lib/labelCollision —— 三者都与 LeafletCanvas 共用，改一处即两套生效。
import { MapControls } from './MapControls';
import { useEffect, useRef } from 'react';
import type { AmapMap, AmapNamespace, AmapOverlay } from '../../lib/amapTypes';
import { dimColor } from '../../lib/colors';
import { resolveLabelCollisions } from '../../lib/labelCollision';
import { markerHtml } from '../../lib/markerHtml';
import type { DayLines, MapPoint } from '../../lib/mapData';
import { ROUTE_STROKE } from '../../lib/routeStyle';

interface Props {
  /** 已加载完成的高德命名空间（由 MapView 在加载成功后传入） */
  amap: AmapNamespace;
  points: MapPoint[];
  dayLines: DayLines[];
  /** 容器可见性：隐藏时 setFitView 会算出零尺寸视野，必须等可见再算 */
  visible: boolean;
  /** 点中地图地点：让中间行程栏切到那天并滚到该景点 */
  onSelectActivity: (dayIndex: number, activityId: string) => void;
}

const FIT_PADDING = [40, 40, 40, 40]; // 上、下、左、右

export function AmapCanvas({ amap, points, dayLines, visible, onSelectActivity }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<AmapMap | null>(null);
  const overlaysRef = useRef<AmapOverlay[]>([]);
  // 回调进 ref：否则每次父组件重渲染都会重建全部覆盖物
  const selectRef = useRef(onSelectActivity);
  selectRef.current = onSelectActivity;
  // 视野自适应的目标 = 当前「查看范围」：总览时是全部天，选了某天时就只有那天
  const fitTargetsRef = useRef<AmapOverlay[]>([]);

  // 覆盖物的输入汇总成一个 key，供下面两个 effect 共用（逐项列依赖只会制造噪声）
  const contentKey = JSON.stringify([
    points.map(({ activity, day, pos, order, color, dimmed }) => ({ activity, dayIndex: day.dayIndex, pos, order, color, dimmed })),
    dayLines,
  ]);

  // 建图（只跑一次）
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const map = new amap.Map(host, {
      // ⚠️ 不要 'point' —— 那才是 POI 与文字标注层
      features: ['bg', 'road', 'building'],
      mapStyle: 'amap://styles/macaron',
      showOversea: true,
      resizeEnable: true,
    });
    mapRef.current = map;
    // 名称避让只在交互结束后各跑一次，不做 rAF 循环 —— 因此不需要圆周旅迹那套迟滞阈值
    const relayout = () => {
      const current = mapRef.current;
      const hostEl = hostRef.current;
      if (current && hostEl) resolveLabelCollisions(hostEl, current.getZoom());
    };
    map.on('zoomend', relayout);
    map.on('moveend', relayout);
    return () => {
      map.off('zoomend', relayout);
      map.off('moveend', relayout);
      map.destroy();
      mapRef.current = null;
      overlaysRef.current = [];
      fitTargetsRef.current = [];
    };
  }, [amap]);

  // 覆盖物随数据重建
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.remove(overlaysRef.current);
    const overlays: AmapOverlay[] = [];
    const focused: AmapOverlay[] = [];

    for (const line of dayLines) {
      // 按天筛选后，非当天仍然画出来，只是压到 faded 档并降到当天之下
      const band = line.dimmed ? ROUTE_STROKE.faded : ROUTE_STROKE.active;
      for (const seg of line.segments) {
        const shape = { path: seg.positions.map((p) => [p.lng, p.lat]), strokeOpacity: band.opacity };
        // 双层折线（数值见 lib/routeStyle）：底衬更粗、压暗一档、无方向箭头
        const under = new amap.Polyline({
          ...shape,
          strokeColor: dimColor(line.color, ROUTE_STROKE.dim),
          strokeWeight: ROUTE_STROKE.underWeight,
          strokeStyle: 'solid',
          lineJoin: 'round',
          lineCap: 'round',
          zIndex: band.underZIndex,
        });
        // 主线叠在底衬上，zIndex 更高；showDir 是高德 JS API 独有的方向箭头
        const main = new amap.Polyline({
          ...shape,
          strokeColor: line.color,
          strokeWeight: ROUTE_STROKE.mainWeight,
          strokeStyle: 'solid',
          showDir: true,
          lineJoin: 'round',
          lineCap: 'round',
          zIndex: band.mainZIndex,
        });
        overlays.push(under, main);
        if (!line.dimmed) focused.push(under, main);
      }
    }

    for (const point of points) {
      const marker = new amap.Marker({
        position: [point.pos.lng, point.pos.lat],
        content: markerHtml({
          color: point.color,
          order: point.order,
          estimated: point.activity.coordSource === 'estimated',
          dimmed: point.dimmed,
          label: point.activity.name,
        }),
        offset: new amap.Pixel(-14, -14),
        // 淡化层的 marker 压到当天之下（线最高 61，故两档都远高于线）
        zIndex: point.dimmed ? 90 : 100,
      });
      marker.on('click', () => selectRef.current(point.day.dayIndex, point.activity.id));
      overlays.push(marker);
      if (!point.dimmed) focused.push(marker);
    }

    map.add(overlays);
    overlaysRef.current = overlays;
    // 淡化层一定与高亮层同时存在，所以 focused 为空只可能是「全部天」被全选的情形，
    // 此时退回全部覆盖物。
    fitTargetsRef.current = focused.length > 0 ? focused : overlays;
    // marker 刚被插进容器，量 rect 要等下一帧
    const raf = requestAnimationFrame(() => {
      const hostEl = hostRef.current;
      const current = mapRef.current;
      if (hostEl && current) resolveLabelCollisions(hostEl, current.getZoom());
    });
    return () => {
      cancelAnimationFrame(raf);
    };
    // contentKey 已覆盖 points / dayLines 的全部输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amap, contentKey]);

  // 尺寸与视野：容器从隐藏变可见（移动端切页签）或查看范围变化时，先 resize 再无动画自适应。
  // 框的是**当前查看范围**：总览 → 全部天，选了某天 → 只框那天（对齐圆周旅迹）。
  // 这要求 .editor-page 有高度约束（见 AppLayout 与 TripEditorPage 的 Tailwind 类）—— 否则容器比屏幕还高，
  // 框出来的视野会有一部分落在屏幕外，看起来就像「定位失灵」。
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => {
      const map = mapRef.current;
      if (!map) return;
      map.resize();
      if (fitTargetsRef.current.length > 0) map.setFitView(fitTargetsRef.current, false, FIT_PADDING);
    }, 60);
    return () => clearTimeout(timer);
  }, [contentKey, visible]);

  return <><div className="amap-host w-full h-full" ref={hostRef} /><MapControls
    onZoomIn={() => mapRef.current?.setZoom(mapRef.current.getZoom() + 1)}
    onZoomOut={() => mapRef.current?.setZoom(mapRef.current.getZoom() - 1)}
    onReset={() => { const map = mapRef.current; if (!map) return; if (fitTargetsRef.current.length) map.setFitView(fitTargetsRef.current, false, FIT_PADDING); else { map.setCenter([105, 35]); map.setZoom(4); } }}
  /></>;

}
