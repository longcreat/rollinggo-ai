// 真实思考节点：与工具步骤同一行样式（图标 + 标题 + 耗时），不展示原文或额外描述。
import { useEffect, useState } from 'react';
import { Brain, LoaderCircle } from 'lucide-react';

export interface ThinkingView {
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
}

export function ThinkingRow({ thinking, className = '' }: { thinking: ThinkingView; className?: string }) {
  const active = thinking.endedAt === undefined && thinking.durationMs === undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const durationMs = thinking.durationMs
    ?? (thinking.startedAt !== undefined ? (thinking.endedAt ?? now) - thinking.startedAt : undefined);
  const seconds = durationMs !== undefined ? Math.max(0, Math.floor(durationMs / 1000)) : undefined;
  // 结束后至少显示 1s；进行中先显示「思考中」，满 1s 再带计时。
  const subtitle = active
    ? seconds && seconds > 0 ? `${seconds}s` : null
    : `${Math.max(1, Math.round((durationMs ?? 0) / 1000))}s`;

  return (
    <div data-agent-activity="" className={`mb-1.5 flex min-w-0 items-center gap-2 text-xs leading-4 text-slate-500 ${className}`}>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {active
          ? <LoaderCircle className="h-3.5 w-3.5 motion-safe:animate-spin text-slate-500" aria-hidden="true" />
          : <Brain className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />}
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className={active ? 'font-medium text-slate-700' : 'text-slate-600'}>{active ? '思考中' : '思考'}</span>
        {subtitle && <span className="ml-1.5 text-slate-400">· {subtitle}</span>}
      </span>
    </div>
  );
}
