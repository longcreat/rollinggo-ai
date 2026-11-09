// 思考节点（对齐 Pi 开源 Agent 的 ThinkingContent 与折叠展开交互）：
// 默认紧凑折叠显示「思考过程 · 3s」，可点击展开查看完整思维链 Markdown；进行中动态计时与流式展现。
// 样式与 AgentActivity 工具行保持像素级左对齐（px-0、h-4 w-4 图标容器、gap-2）。
import { useEffect, useState } from 'react';
import { Brain, ChevronDown, LoaderCircle } from 'lucide-react';
import { ChatText } from './ChatText';

export interface ThinkingView {
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  thinking?: string;
  chunks?: number;
}

export function ThinkingRow({ thinking, className = '' }: { thinking: ThinkingView; className?: string }) {
  const active = thinking.endedAt === undefined && thinking.durationMs === undefined;
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const durationMs = thinking.durationMs
    ?? (thinking.startedAt !== undefined ? (thinking.endedAt ?? now) - thinking.startedAt : undefined);
  const seconds = durationMs !== undefined ? Math.max(0, Math.floor(durationMs / 1000)) : undefined;

  const durationLabel = active
    ? seconds && seconds > 0 ? `${seconds}s` : null
    : `${Math.max(1, Math.round((durationMs ?? 0) / 1000))}s`;

  const thinkingText = thinking.thinking?.trim();
  const canExpand = Boolean(thinkingText);

  return (
    <div data-agent-activity="" className={`mb-2 min-w-0 ${className}`}>
      <button
        type="button"
        disabled={!canExpand}
        onClick={() => canExpand && setOpen((prev) => !prev)}
        aria-expanded={canExpand ? open : undefined}
        className={`group flex min-w-0 max-w-full items-center gap-2 px-0 py-0.5 text-xs text-slate-500 transition-colors ${
          canExpand
            ? 'cursor-pointer hover:text-slate-800'
            : 'cursor-default'
        }`}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {active ? (
            <LoaderCircle className="h-3.5 w-3.5 motion-safe:animate-spin text-slate-500" aria-hidden="true" />
          ) : (
            <Brain className="h-3.5 w-3.5 text-slate-400 group-hover:text-slate-600 transition-colors" aria-hidden="true" />
          )}
        </span>

        <span className="truncate font-medium text-slate-600 group-hover:text-slate-800">
          {active ? '思考中' : '思考过程'}
        </span>

        {durationLabel && (
          <span className="shrink-0 text-slate-400 font-mono text-[11px]">
            · {durationLabel}
          </span>
        )}

        {canExpand && (
          <ChevronDown
            className={`h-3 w-3 shrink-0 text-slate-400 transition-transform duration-200 group-hover:text-slate-600 ${
              open ? 'rotate-180' : ''
            }`}
            aria-hidden="true"
          />
        )}
      </button>

      {open && thinkingText && (
        <div className="mt-1.5 mb-2 max-w-full rounded-r-lg border-l-2 border-slate-300 bg-slate-50/70 pl-3 pr-2 py-2 text-xs leading-relaxed text-slate-600 select-text">
          <div className="chat-markdown font-sans text-slate-600">
            <ChatText text={thinkingText} markdown />
          </div>
        </div>
      )}
    </div>
  );
}
