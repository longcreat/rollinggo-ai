// 高德 JS API 的最小类型声明（09-26）：官方不提供 TS 类型，而本项目只用到很小一部分 API。
// 刻意**不装** `@amap/amap-jsapi-types`（几百行全量声明里我们用不到 5%），也不写 `any` ——
// 只把实际调用的方法声明出来，参数用 `Record<string, unknown>` 保持宽松但可检查。

export interface AmapOverlay {
  setMap(map: AmapMap | null): void;
}

export interface AmapMarker extends AmapOverlay {
  on(event: 'click', handler: () => void): void;
}

export interface AmapMap {
  add(overlays: AmapOverlay[]): void;
  remove(overlays: AmapOverlay[]): void;
  /** avoid 是四边留白（上、下、左、右） */
  setFitView(overlays?: AmapOverlay[], immediately?: boolean, avoid?: number[]): void;
  resize(): void;
  destroy(): void;
  /** 只声明本项目真正监听的两个事件；高德与 Leaflet 在这两个名字上意外地一致 */
  on(event: AmapMapEvent, handler: () => void): void;
  off(event: AmapMapEvent, handler: () => void): void;
  getZoom(): number;
  setZoom(zoom: number): void;
  setCenter(center: [number, number]): void;
}

type AmapMapEvent = 'zoomend' | 'moveend';

/** 全局 `AMap` 命名空间里我们用到的那几个构造器 */
export interface AmapNamespace {
  Map: new (container: HTMLElement, options: Record<string, unknown>) => AmapMap;
  Marker: new (options: Record<string, unknown>) => AmapMarker;
  Polyline: new (options: Record<string, unknown>) => AmapOverlay;
  Pixel: new (x: number, y: number) => unknown;
}

declare global {
  interface Window {
    AMap?: AmapNamespace;
  }
}
