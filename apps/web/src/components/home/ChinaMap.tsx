import { Button } from '../ui/Button';
// 首页 SVG 中国地图（09-26）：省界 + 国界 + 已覆盖城市打点，桌面支持拖拽、滚轮缩放与缩放胶囊。
// 桌面拖拽热区与画布整屏；手机固定完整地图，仅点选城市并保留纵向页面滚动。
// 地图内容靠内部 translate/scale 视图变换摆放，可平移范围与缩放范围都放宽。
// 视图变换不走 React state：拖拽时直接改 <g> 的 transform 属性，避免每帧重渲染造成闪烁。
// 选择城市只改圆点样式（变大 + 光圈），文字位置与样式保持不变；点空白处不会取消已选城市。
import { useEffect, useId, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { CHINA_OUTLINE_PATH, CITY_LABEL_OFFSETS, DEFAULT_LABEL_OFFSET } from '../../lib/chinaMap';
import { CHINA_PROVINCES_PATH } from '../../lib/chinaProvinces';
import { MinusIcon, PlusIcon, ResetIcon } from './HomeIcons';

export interface MapCityDot {
  name: string;
  x: number;
  y: number;
}

interface ChinaMapProps {
  cities: MapCityDot[];
  contextCities: MapCityDot[];
  selected: string | null;
  onSelect: (name: string) => void;
  mode?: 'home' | 'picker';
}

interface ViewState {
  x: number;
  y: number;
  zoom: number;
}

const DRAG_THRESHOLD = 6;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 3;
const ZOOM_STEP = 1.25;
/** 初始视图：把地图推到稿子里的位置（偏右、靠上），并比 1:1 略大一点，留出可平移的余量 */
const INITIAL_VIEW: ViewState = { x: 165, y: 10, zoom: 0.88 };
/** 手机在原始 900×700 画布中完整展示主图，南海诸岛沿用右下角插图。 */
const MOBILE_VIEW: ViewState = { x: 0, y: 0, zoom: 1 };

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** 平移边界：地图至少有一半留在视口里，最多可以推到只剩一半 */
const panBounds = (zoom: number) => ({
  xMin: 450 - 900 * zoom,
  xMax: 450,
  yMin: 350 - 700 * zoom,
  yMax: 350,
});

const toTransform = (v: ViewState) => `translate(${v.x} ${v.y}) scale(${v.zoom})`;

export function ChinaMap({ cities, contextCities, selected, onSelect, mode = 'home' }: ChinaMapProps) {
  const glowId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<SVGGElement>(null);
  const [dragging, setDragging] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia('(width < 1024px)').matches);
  const viewRef = useRef<ViewState>(mobile ? MOBILE_VIEW : INITIAL_VIEW);
  const gesture = useRef({ down: false, pointerId: -1, moved: false, captured: false, px: 0, py: 0 });

  useEffect(() => {
    const query = window.matchMedia('(width < 1024px)');
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const view = mobile ? MOBILE_VIEW : INITIAL_VIEW;
    viewRef.current = view;
    groupRef.current?.setAttribute('transform', toTransform(view));
    gesture.current = { ...gesture.current, down: false, moved: false, captured: false };
    setDragging(false);
  }, [mobile]);

  /** 唯一的视图写入口：改 DOM 属性（不走 React），拖动/缩放每帧都安全 */
  const applyView = (next: ViewState) => {
    viewRef.current = next;
    groupRef.current?.setAttribute('transform', toTransform(next));
  };

  /** 屏幕坐标 → SVG 用户坐标（不含内部地图变换） */
  const toSvgPoint = (clientX: number, clientY: number) => {
    const matrix = svgRef.current?.getScreenCTM();
    return matrix
      ? new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse())
      : new DOMPoint(450, 350);
  };

  const zoomAt = (nextZoom: number, anchor: { x: number; y: number }) => {
    if (mobile) return;
    const cur = viewRef.current;
    const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    const ratio = zoom / cur.zoom;
    const bounds = panBounds(zoom);
    applyView({
      zoom,
      x: clamp(anchor.x - (anchor.x - cur.x) * ratio, bounds.xMin, bounds.xMax),
      y: clamp(anchor.y - (anchor.y - cur.y) * ratio, bounds.yMin, bounds.yMax),
    });
  };

  // React 合成 wheel 是 passive 无法 preventDefault，滚轮缩放必须原生监听
  useEffect(() => {
    const svg = svgRef.current;
    const surface = surfaceRef.current;
    if (!svg || !surface || mobile) return;
    const onWheel = (e: WheelEvent) => {
      if (window.matchMedia('(width < 1024px)').matches) return;
      e.preventDefault();
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      const anchor = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
      // 指数式连续缩放，比固定步进顺手（同 Yuntu）
      zoomAt(viewRef.current.zoom * Math.exp(-e.deltaY * 0.0015), anchor);
    };
    surface.addEventListener('wheel', onWheel, { passive: false });
    return () => surface.removeEventListener('wheel', onWheel);
  }, [mobile]);

  // 按下左键（或触控/手写笔）才开始手势；不按键移动鼠标绝不能把地图带走
  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    gesture.current = {
      down: true,
      pointerId: e.pointerId,
      moved: false,
      captured: false,
      px: e.clientX,
      py: e.clientY,
    };
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g.down || e.pointerId !== g.pointerId) return;
    // 鼠标左键中途松开（事件丢失时）也算结束，避免悬停继续拖
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      g.down = false;
      setDragging(false);
      return;
    }
    if (!g.moved && Math.hypot(e.clientX - g.px, e.clientY - g.py) < DRAG_THRESHOLD) return;
    // 手机拖动不改变视图，并防止滑动结束时误选城市；纵向手势交给页面滚动。
    if (mobile) {
      g.moved = true;
      return;
    }
    if (!g.moved) {
      g.moved = true;
      setDragging(true);
      // 捕获指针：拖出热区后还能继续收到 move。捕获失败（合成事件、指针已释放）时退化为普通拖动
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
        g.captured = true;
      } catch {
        g.captured = false;
      }
    }
    const prev = toSvgPoint(g.px, g.py);
    const curr = toSvgPoint(e.clientX, e.clientY);
    g.px = e.clientX;
    g.py = e.clientY;
    const cur = viewRef.current;
    const bounds = panBounds(cur.zoom);
    applyView({
      ...cur,
      x: clamp(cur.x + curr.x - prev.x, bounds.xMin, bounds.xMax),
      y: clamp(cur.y + curr.y - prev.y, bounds.yMin, bounds.yMax),
    });
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (gesture.current.captured && e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    gesture.current = { ...gesture.current, down: false, captured: false };
    setDragging(false);
  }

  const selectCity = (name: string) => {
    if (!gesture.current.moved) onSelect(name);
  };

  return (
    <div
      ref={surfaceRef}
      className={`shrink-0 select-none overflow-hidden ${mode === 'picker' ? 'relative my-2 aspect-[9/7] max-h-[50svh] w-full lg:aspect-auto lg:h-[420px] lg:max-h-none' : 'relative my-2 aspect-[9/7] w-full lg:absolute lg:inset-0 lg:my-0 lg:aspect-auto lg:h-auto'} ${mobile ? 'touch-pan-y cursor-default' : dragging ? 'touch-none cursor-grabbing' : 'touch-none cursor-grab'}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <svg
        ref={svgRef}
        viewBox="0 0 900 700"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="中国地图，点击城市圆点选择目的地"
        className="pointer-events-none absolute inset-0 block h-full w-full"
      >
        <g ref={groupRef} transform={toTransform(mobile ? MOBILE_VIEW : INITIAL_VIEW)}>
          <defs>
            <radialGradient id={glowId}>
              <stop offset="0%" stopColor="var(--color-brand-glow)" stopOpacity={0.28} />
              <stop offset="55%" stopColor="var(--color-brand-sky)" stopOpacity={0.14} />
              <stop offset="100%" stopColor="var(--color-brand-sky)" stopOpacity={0} />
            </radialGradient>
          </defs>
          {/* 国界填色 → 省界细线 → 国界描边，顺序决定线宽叠加关系。
              线宽用用户单位（不用 non-scaling-stroke）：省界近 7400 个点，每帧重算描边会掉帧发闪。 */}
          <path d={CHINA_OUTLINE_PATH} fill="rgba(255,255,255,0.5)" stroke="none" />
          <path d={CHINA_PROVINCES_PATH} fill="none" className="stroke-map-line" strokeWidth={0.7} />
          <path d={CHINA_OUTLINE_PATH} fill="none" className="stroke-map-line-strong" strokeWidth={1} />

          {/* 未覆盖城市：只作背景点缀，不可点选、不带标签 */}
          {contextCities.map((city) => (
            <circle key={`ctx-${city.name}`} cx={city.x} cy={city.y} r={2.2} className="fill-map-dot" />
          ))}

          {cities.map((city) => {
            const active = city.name === selected;
            // 手机标签放大后，济南向左避开相邻青岛；桌面沿用原偏移。
            const offset = mobile && city.name === '济南'
              ? { dx: -10, dy: -6, align: 'end' as const }
              : CITY_LABEL_OFFSETS[city.name] ?? DEFAULT_LABEL_OFFSET;
            return (
              <g
                key={city.name}
                transform={`translate(${city.x} ${city.y})`}
                className="pointer-events-auto cursor-pointer outline-none"
                role="button"
                aria-label={`选择目的地城市 ${city.name}`}
                aria-pressed={active}
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  selectCity(city.name);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(city.name);
                  }
                }}
              >
                {active && <circle r={20} fill={`url(#${glowId})`} />}
                {active && <circle className={"map-city-ripple [fill:none] [stroke:var(--color-brand-deep)] [stroke-width:1.6] [animation:map-city-pulse_2.4s_ease-out_infinite] motion-reduce:animate-none"} r={6} />}
                {active && <circle className={"map-city-ripple [fill:none] [stroke:var(--color-brand-deep)] [stroke-width:1.6] [animation:map-city-pulse_2.4s_ease-out_infinite] map-city-ripple-late [animation-delay:1.2s] motion-reduce:animate-none"} r={6} />}
                <circle
                  r={active ? 5.2 : 3.6}
                  className={`transition-[r] ${active ? "fill-brand-deep" : "fill-accent-cyan"}`}
                  stroke={active ? '#fff' : 'none'}
                  strokeWidth={active ? 1.2 : 0}
                />
                {/* 标签按城市各自的防重叠偏移摆放，选中与否都不改位置 */}
                <text
                  x={offset.dx}
                  y={offset.dy}
                  textAnchor={offset.align}
                  dominantBaseline="middle"
                  className={"map-city-label [paint-order:stroke] [stroke:rgba(255,_255,_255,_0.85)] [stroke-width:3px] fill-ink-map text-[9px] font-semibold max-lg:text-[30px]"}
                >
                  {city.name}
                </text>
              </g>
            );
          })}

          {/* 南海诸岛插图：主图 viewBox 裁掉 y>700 的岛屿，单独开窗放在版图右下角 */}
          <rect
            x={720}
            y={498}
            width={150}
            height={120}
            rx={6}
            fill="rgba(255,255,255,0.35)"
            className="stroke-map-line"
            strokeWidth={0.7}
          />
          <svg x={720} y={498} width={150} height={120} viewBox="480 690 250 270" aria-hidden="true">
            <path d={CHINA_OUTLINE_PATH} fill="none" strokeWidth={1} className="stroke-map-line-strong" />
          </svg>
          <text
            x={795}
            y={608}
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-ink-muted text-[9px]"
          >
            南海诸岛
          </text>
        </g>
      </svg>

      {/* 缩放胶囊（右下角，同 Yuntu 的 map tools）：按钮不把 pointerdown 传给拖拽热区 */}
      {!mobile && <div
        className="absolute right-[2.5%] bottom-[calc(190*var(--ui))] z-20 flex flex-col items-center gap-[calc(4*var(--ui))] rounded-[calc(24*var(--ui))] border border-white/70 bg-white/72 p-[calc(7*var(--ui))] shadow-[0_10px_30px_rgba(31,64,124,0.12)] backdrop-blur-2xl backdrop-saturate-150"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Button variant="plain"
          type="button"
          aria-label="放大地图"
          title="放大"
          onClick={() => zoomAt(viewRef.current.zoom * ZOOM_STEP, { x: 450, y: 350 })}
          className="grid h-[calc(34*var(--ui))] w-[calc(34*var(--ui))] place-items-center rounded-full text-ink-soft transition-colors hover:bg-white/80 hover:text-brand"
        >
          <PlusIcon className="h-[calc(18*var(--ui))] w-[calc(18*var(--ui))]" />
        </Button>
        <span aria-hidden="true" className="h-px w-[calc(18*var(--ui))] bg-hairline-strong" />
        <Button variant="plain"
          type="button"
          aria-label="缩小地图"
          title="缩小"
          onClick={() => zoomAt(viewRef.current.zoom / ZOOM_STEP, { x: 450, y: 350 })}
          className="grid h-[calc(34*var(--ui))] w-[calc(34*var(--ui))] place-items-center rounded-full text-ink-soft transition-colors hover:bg-white/80 hover:text-brand"
        >
          <MinusIcon className="h-[calc(18*var(--ui))] w-[calc(18*var(--ui))]" />
        </Button>
        <span aria-hidden="true" className="h-px w-[calc(18*var(--ui))] bg-hairline-strong" />
        <Button variant="plain"
          type="button"
          aria-label="重置地图"
          title="回到默认视角"
          onClick={() => applyView(INITIAL_VIEW)}
          className="grid h-[calc(34*var(--ui))] w-[calc(34*var(--ui))] place-items-center rounded-full text-ink-soft transition-colors hover:bg-white/80 hover:text-brand"
        >
          <ResetIcon className="h-[calc(18*var(--ui))] w-[calc(18*var(--ui))]" />
        </Button>
      </div>}
    </div>
  );
}


