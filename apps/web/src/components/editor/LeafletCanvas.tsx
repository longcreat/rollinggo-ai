// Leaflet 渲染（09-26 从 MapView 抽出）：**降级路径** —— 未配高德 JS API Key、
// 或 SDK 加载失败/超时（见 MapView 的选择逻辑）时使用。
// 与 AmapCanvas 共用 lib/mapData 的点与线，这里只负责把 GeoPos 翻成 Leaflet 的 [lat, lng]。
//
// 路线是双层折线（参数见 lib/routeStyle），marker 带名称标签（HTML 见 lib/markerHtml，
// 与高德侧同一个生成函数），标签避让见 lib/labelCollision。
// 点 marker 不弹气泡，直接让中间行程栏跳转到对应景点（onSelectActivity 由 TripEditorPage 传入）。
import { MapControls } from './MapControls';
import { useEffect } from 'react';
import L from 'leaflet';
import { MapContainer, Marker, Polyline, TileLayer, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';   // 随本模块进编辑器分包，不进首屏 CSS
import { dimColor } from '../../lib/colors';
import { resolveLabelCollisions } from '../../lib/labelCollision';
import { markerHtml } from '../../lib/markerHtml';
import { collectDayLines, type DayLines, type GeoPos, type MapPoint } from '../../lib/mapData';
import { ROUTE_STROKE } from '../../lib/routeStyle';

interface Props {
  points: MapPoint[];
  dayLines: DayLines[];
  /** 容器可见性（桌面端常驻可见；≤768px 由移动页签决定） */
  visible: boolean;
  /** 点中地图地点：让中间行程栏切到那天并滚到该景点 */
  onSelectActivity: (dayIndex: number, activityId: string) => void;
}

const toLatLng = (pos: GeoPos): [number, number] => [pos.lat, pos.lng];

function mapIcon(point: MapPoint): L.DivIcon {
  return L.divIcon({
    className: "marker-wrap [background:none] [border:none]",
    html: markerHtml({
      color: point.color,
      order: point.order,
      estimated: point.activity.coordSource === 'estimated',
      dimmed: point.dimmed,
      label: point.activity.name,
    }),
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  });
}

// 尺寸与视野控制：容器从隐藏变可见（移动端切页签）或点位变化时，
// 先 invalidateSize 再无动画 fitBounds —— 避免「隐藏容器初始化导致零尺寸定位」的经典坑
function MapController({ points, visible }: { points: MapPoint[]; visible: boolean }) {
  const map = useMap();

  // 名称避让只在交互结束后各跑一次（与 AmapCanvas 一致），不做 rAF 循环。
  // divIcon 的 DOM 挂在 map 容器内，所以用 getContainer() 当测量根。
  useEffect(() => {
    const relayout = () => resolveLabelCollisions(map.getContainer(), map.getZoom());
    map.on('zoomend', relayout);
    map.on('moveend', relayout);
    return () => {
      map.off('zoomend', relayout);
      map.off('moveend', relayout);
    };
  }, [map]);

  // 框的是**当前查看范围**：总览 → 全部天，选了某天 → 只框那天（对齐圆周旅迹）。
  // 这要求 .editor-page 有高度约束（见 AppLayout 与 TripEditorPage 的 Tailwind 类）—— 否则容器比屏幕还高，
  // 框出来的视野会有一部分落在屏幕外，看起来就像「定位失灵」。
  const focused = points.filter((p) => !p.dimmed);
  const targets = focused.length > 0 ? focused : points;
  const key = targets.map((p) => `${p.activity.id}:${p.pos.lat},${p.pos.lng}`).join('|');

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => {
      map.invalidateSize();
      if (targets.length > 0) {
        const bounds = L.latLngBounds(targets.map((p) => toLatLng(p.pos)));
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15, animate: false });
      }
      // fitBounds 之后 marker 已在目标位置，直接补一次避让（不依赖它抛出的事件）
      resolveLabelCollisions(map.getContainer(), map.getZoom());
    }, 60);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, visible, map]);
  return <MapControls onZoomIn={() => map.zoomIn()} onZoomOut={() => map.zoomOut()} onReset={() => {
    if (targets.length) map.fitBounds(L.latLngBounds(targets.map((point) => toLatLng(point.pos))), { padding: [40, 40], maxZoom: 15, animate: false });
    else map.setView([35, 105], 4);
  }} />;
}

export function LeafletCanvas({ points, dayLines, visible, onSelectActivity }: Props) {
  return (
    <MapContainer center={[35.0, 105.0]} zoom={4} className={"leaflet-host w-full h-full"} scrollWheelZoom zoomControl={false}>
      <TileLayer
        url="https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}"
        subdomains={['1', '2', '3', '4']}
        attribution="&copy; 高德地图"
      />
      {dayLines.map((line) =>
        line.segments.flatMap((seg) => {
          // 与 AmapCanvas 同一种双层折线（数值见 lib/routeStyle）。Leaflet 的 Path
          // 没有 zIndex，靠 JSX 顺序决定绘制层次 —— 所以底衬必须在主线之前返回。
          // 也没有高德 showDir 那样的方向箭头，两侧的差异仅此一项。
          const band = line.dimmed ? ROUTE_STROKE.faded : ROUTE_STROKE.active;
          const positions = seg.positions.map(toLatLng);
          return [
            <Polyline
              key={`${line.dayIndex}:${seg.key}:under`}
              positions={positions}
              pathOptions={{
                color: dimColor(line.color, ROUTE_STROKE.dim),
                weight: ROUTE_STROKE.underWeight,
                opacity: band.opacity,
              }}
            />,
            <Polyline
              key={`${line.dayIndex}:${seg.key}:main`}
              positions={positions}
              pathOptions={{ color: line.color, weight: ROUTE_STROKE.mainWeight, opacity: band.opacity }}
            />,
          ];
        }),
      )}
      {points.map((point) => (
        <Marker
          key={point.activity.id}
          position={toLatLng(point.pos)}
          icon={mapIcon(point)}
          eventHandlers={{ click: () => onSelectActivity(point.day.dayIndex, point.activity.id) }}
        />
      ))}
      <MapController points={points} visible={visible} />
    </MapContainer>
  );
}
