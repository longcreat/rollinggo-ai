// ZCode / OpenCode 标志性 Soft Radar 5x5 点阵雷达动态 SVG 组件。
// 纯黑白灰/currentColor 继承，顺时针环绕扫光微波，中心点稳定常亮。
import { useId } from 'react';

// 25 个点位坐标与扫光动画相位（对齐 opencode/packages/ui/src/components/spinner-radar）
const RADAR_DOTS = [
  { x: 1, y: 1, at: 0.875, shape: 0 },
  { x: 4, y: 1, at: 0.926, shape: 1 },
  { x: 7, y: 1, at: 0.000, shape: 2 },
  { x: 10, y: 1, at: 0.074, shape: 3 },
  { x: 13, y: 1, at: 0.125, shape: 0 },
  { x: 1, y: 4, at: 0.824, shape: 3 },
  { x: 4, y: 4, at: 0.875, shape: 4 },
  { x: 7, y: 4, at: 0.000, shape: 4 },
  { x: 10, y: 4, at: 0.125, shape: 4 },
  { x: 13, y: 4, at: 0.176, shape: 1 },
  { x: 1, y: 7, at: 0.750, shape: 2 },
  { x: 4, y: 7, at: 0.750, shape: 4 },
  // 中心点 (7, 7) 为稳定常亮核
  { x: 7, y: 7, steady: true },
  { x: 10, y: 7, at: 0.250, shape: 4 },
  { x: 13, y: 7, at: 0.250, shape: 2 },
  { x: 1, y: 10, at: 0.676, shape: 1 },
  { x: 4, y: 10, at: 0.625, shape: 4 },
  { x: 7, y: 10, at: 0.500, shape: 4 },
  { x: 10, y: 10, at: 0.375, shape: 4 },
  { x: 13, y: 10, at: 0.324, shape: 3 },
  { x: 1, y: 13, at: 0.625, shape: 0 },
  { x: 4, y: 13, at: 0.574, shape: 3 },
  { x: 7, y: 13, at: 0.500, shape: 2 },
  { x: 10, y: 13, at: 0.426, shape: 1 },
  { x: 13, y: 13, at: 0.375, shape: 0 },
];

const LOOP_SECONDS = 1.8;

export function SoftRadar({ size = 14, className = 'text-slate-700' }: { size?: number; className?: string }) {
  const scopeId = useId().replace(/:/g, '');
  const animName = `sr-${scopeId}`;

  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="currentColor"
      className={`shrink-0 overflow-visible ${className}`}
      aria-hidden="true"
    >
      <style>{`
        @keyframes ${animName} {
          0% { opacity: 1; }
          6% { opacity: 0.95; }
          22% { opacity: 0.45; }
          50% { opacity: 0.18; }
          100% { opacity: 0.18; }
        }
      `}</style>
      {RADAR_DOTS.map((dot, index) => {
        if ('steady' in dot && dot.steady) {
          return (
            <rect
              key={`steady-${index}`}
              x={dot.x}
              y={dot.y}
              width={2}
              height={2}
              rx={0.5}
              opacity={0.95}
            />
          );
        }
        const delay = -LOOP_SECONDS * (1 - (dot.at ?? 0));
        return (
          <rect
            key={`dot-${index}`}
            x={dot.x}
            y={dot.y}
            width={2}
            height={2}
            rx={0.5}
            style={{
              animation: `${animName} ${LOOP_SECONDS}s linear ${delay.toFixed(3)}s infinite`,
            }}
          />
        );
      })}
    </svg>
  );
}
