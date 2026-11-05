// 地图面板（09-26 重构）：渲染器选择 + 数据计算。
//   · 主路径 AmapCanvas（高德 JS API）—— 唯一目的是能用 `features` 关掉 POI 文字层
//   · 降级 LeafletCanvas（高德栅格瓦片）—— 未配 JS Key、或 SDK 加载失败 / 超时
// 选择逻辑只在本文件；两个 canvas 只负责把数据画出来（数据层见 lib/mapData）。
// 地图上不带天数筛选：按天淡化只由左栏天数页签（editor-day-tabs）驱动同一个 dayFilter。
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { loadAmapSdk } from '../../lib/amapLoader';
import { collectDayLines, collectPoints } from '../../lib/mapData';
import type { AmapNamespace } from '../../lib/amapTypes';
import { useEditorStore } from '../../store/editorStore';
import { AmapCanvas } from './AmapCanvas';

// Leaflet 只在真的降级时才下载（含 leaflet 本体与地图样式，约 78 kB gzip）：
// 走高德主路径的用户不必付这份体积。
const LeafletCanvas = lazy(() => import('./LeafletCanvas').then((m) => ({ default: m.LeafletCanvas })));

interface AmapJsConfig {
  amapJsKey: string;
  amapJsSecurityCode: string;
}

// 桌面端地图常驻可见；≤1100px 时由移动页签决定
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia('(min-width: 1101px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1101px)');
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isDesktop;
}

/**
 * 渲染器选择：**高德优先**，Leaflet 只在不可用时作为降级路径按需加载。
 * probing 阶段（配置查询 + SDK 加载，正常为百毫秒级，最坏 8 秒超时）显示占位而不是先画 Leaflet ——
 * 先画降级路径再切主路径会让底图闪一次、点位跳动一次。
 * 未配 Key 是正常配置状态，直接降级且不告警；只有接口失败、SDK 加载失败/超时、命名空间缺失才打 warn。
 */
type MapRenderer = { kind: 'probing' } | { kind: 'amap'; namespace: AmapNamespace } | { kind: 'leaflet' };

function useMapRenderer(): MapRenderer {
  // 同一页面内 SDK 只注入一次；二次进编辑器直接用已挂好的命名空间，不再多一次配置请求与占位帧。
  const [renderer, setRenderer] = useState<MapRenderer>(() =>
    window.AMap ? { kind: 'amap', namespace: window.AMap } : { kind: 'probing' });
  useEffect(() => {
    if (window.AMap) return;
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await api.get<AmapJsConfig>('/api/settings/config');
        if (!cfg.amapJsKey || !cfg.amapJsSecurityCode) {
          if (!cancelled) setRenderer({ kind: 'leaflet' }); // 未配置：正常降级，不告警
          return;
        }
        await loadAmapSdk({ key: cfg.amapJsKey, securityJsCode: cfg.amapJsSecurityCode });
        const namespace = window.AMap;
        if (!namespace) throw new Error('SDK 已加载但未挂到 window.AMap');
        if (!cancelled) setRenderer({ kind: 'amap', namespace });
      } catch (err) {
        console.warn('[map] 高德 JS API 不可用，降级 Leaflet：', err instanceof Error ? err.message : err);
        if (!cancelled) setRenderer({ kind: 'leaflet' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return renderer;
}

/** 探测与 Leaflet chunk 下载期间的占位：不渲染任何地图，也不报错。 */
function MapPlaceholder() {
  return <div className={"grid h-full w-full place-items-center text-sm [color:var(--color-muted)]"} aria-hidden="true">地图加载中…</div>;
}

export function MapView({ visible, onSelectActivity }: { visible: boolean; onSelectActivity: (dayIndex: number, activityId: string) => void }) {
  const trip = useEditorStore((s) => s.trip);
  const dayFilter = useEditorStore((s) => s.dayFilter);
  const isDesktop = useIsDesktop();
  const renderer = useMapRenderer();

  // 按天筛选不再把其他天从数据里删掉 —— 它们仍然画出来，只是被标成 dimmed 由画布淡化
  const allDays = useMemo(() => trip?.days ?? [], [trip]);
  const points = useMemo(() => collectPoints(allDays, dayFilter), [allDays, dayFilter]);
  const dayLines = useMemo(() => collectDayLines(allDays, dayFilter), [allDays, dayFilter]);
  const canvasProps = { points, dayLines, visible: visible || isDesktop, onSelectActivity };

  return (
    <div className="map-pane absolute inset-0 flex flex-col h-full w-full">
      <div className="editor-map-canvas relative flex-1 min-h-0 w-full h-full rounded-2xl overflow-hidden [isolation:isolate]">
        {renderer.kind === 'amap'
          ? <AmapCanvas amap={renderer.namespace} {...canvasProps} />
          : renderer.kind === 'leaflet'
            ? <Suspense fallback={<MapPlaceholder />}><LeafletCanvas {...canvasProps} /></Suspense>
            : <MapPlaceholder />}
      </div>
      {points.length === 0 && <div className="map-empty absolute z-[1000] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white/90 rounded-xl px-4 py-2 text-slate-500 text-sm">暂无可标注的活动坐标</div>}
    </div>
  );
}
