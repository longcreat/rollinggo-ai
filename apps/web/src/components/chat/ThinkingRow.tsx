// 真实思考节点：跟着时间线出现，只显示状态与耗时，不展示原始 CoT 或多余描述。
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
  const seconds = durationMs !== undefined ? Math.floor(durationMs / 1000) : undefined;
  const label = active
    ? seconds && seconds > 0 ? `思考中 · ${seconds}s` : '思考中'
    : seconds !== undefined ? `思考 ${Math.max(1, Math.round((durationMs ?? 0) / 1000))}s` : '思考完成';

  return (
    <div className={`mb-1.5 flex items-center gap-1.5 px-1 text-xs text-slate-400 ${className}`} aria-live="polite">
      {active
        ? <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        : <Brain className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
      <span>{label}</span>
    </div>
  );
}
