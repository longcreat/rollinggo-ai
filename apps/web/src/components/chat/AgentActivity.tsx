// 一轮 Agent 的处理过程：单步一行，多步可折叠；运行中展开，完成后收成「已完成」，失败/停止保持展开。
// 只展示工具动作标签，不展示参数、结果、耗时或模型思维链。
import { useEffect, useId, useRef, useState } from 'react';
import type { AgentStep } from '@tripweaver/shared';
import { AlertCircle, Check, ChevronDown, MinusCircle } from 'lucide-react';
import type { AgentActivityState } from '../../lib/agentActivity';
import { Button } from '../ui/Button';
import { SoftRadar } from '../ui/SoftRadar';

const TITLE: Record<AgentActivityState, string> = {
  running: '处理中',
  completed: '已完成',
  stopped: '已停止',
  error: '未完成',
};

function formatDuration(ms?: number): string | null {
  if (!ms || ms <= 0) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function StatusIcon({ status, className = '', size = 13 }: { status: AgentStep['status']; className?: string; size?: number }) {
  if (status === 'running') return <SoftRadar size={size} className="text-slate-700" />;
  if (status === 'error') return <AlertCircle className={`text-rose-500 ${className}`} aria-hidden="true" />;
  if (status === 'stopped') return <MinusCircle className={`text-slate-400 ${className}`} aria-hidden="true" />;
  return <Check className={`text-slate-500 ${className}`} aria-hidden="true" strokeWidth={2.2} />;
}

function singleText(row: AgentStep, status: AgentStep['status'], state: AgentActivityState) {
  if (status === 'running') return `正在${row.label}…`;
  if (state === 'stopped') return `已停止 · ${row.label}`;
  if (state === 'error') return `未完成 · ${row.label}`;
  return `已完成 · ${row.label}`;
}

export function AgentActivity({ steps, state }: {
  steps: readonly AgentStep[];
  state: AgentActivityState;
}) {
  const rows = steps;
  const running = state === 'running';
  const [open, setOpen] = useState(running || state === 'stopped' || state === 'error');
  const [showAll, setShowAll] = useState(false);
  const userToggled = useRef(false);
  const previousState = useRef(state);
  const listId = useId();

  useEffect(() => {
    if (previousState.current === 'running' && state === 'completed' && !userToggled.current) setOpen(false);
    if (state === 'running' || state === 'stopped' || state === 'error') setOpen(true);
    previousState.current = state;
  }, [state]);

  if (!rows.length) return null;
  // 停止/中断时不保留「还在转」的视觉：客户端可能没收到最后的 tool_end。
  const rowStatus = (status: AgentStep['status']): AgentStep['status'] => status === 'running' && !running
    ? state === 'error' ? 'error' : state === 'stopped' ? 'stopped' : 'done'
    : status;

  // 单步不折叠、不再重复一行标题；运行中直接显示当前动作。
  if (rows.length === 1) {
    const row = rows[0]!;
    const status = rowStatus(row.status);
    const duration = status !== 'running' ? formatDuration(row.durationMs) : null;
    return <div data-agent-activity="" className="mb-2 flex min-w-0 items-center gap-2 text-xs leading-4 text-slate-500">
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <StatusIcon status={status} className="h-3.5 w-3.5" />
      </span>
      <span className={`min-w-0 flex-1 truncate ${status === 'running' ? 'font-medium text-slate-700' : 'text-slate-600'}`}>
        {singleText(row, status, state)}
        {duration && <span className="ml-1.5 text-slate-400 font-mono text-[11px]">· {duration}</span>}
      </span>
    </div>;
  }

  const totalDuration = rows.reduce((acc, row) => acc + (row.durationMs ?? 0), 0);
  const formattedTotal = formatDuration(totalDuration);
  const meta = `${steps.length} 步${formattedTotal ? ` · ${formattedTotal}` : ''}`;
  const collapseMobileRows = rows.length > 2 && !showAll;

  return (
    <section data-agent-activity="" className="mb-2 w-full min-w-0 text-xs">
      <Button
        variant="plain"
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => { userToggled.current = true; setOpen((value) => !value); }}
        className="group flex w-full min-w-0 items-center gap-2 rounded-md px-0 py-0.5 text-left transition-colors hover:text-slate-800"
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {running ? (
            <SoftRadar size={14} className="text-slate-700" />
          ) : (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-slate-500" aria-hidden="true">
              <rect x="2.5" y="2.5" width="11" height="4.5" rx="1.5"/>
              <path d="M4.5 10.5h7M6 13.5h4" strokeOpacity="0.6"/>
            </svg>
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">
          <span className={`font-medium ${running ? 'text-slate-700' : 'text-slate-600'}`}>{TITLE[state]}</span>
          <span className="ml-1.5 text-slate-400 font-mono text-[11px]"> · {meta}</span>
        </span>
        <ChevronDown
          className={`ml-auto h-3 w-3 shrink-0 text-slate-400 transition-transform duration-200 group-hover:text-slate-600 ${open ? '' : '-rotate-90'}`}
          aria-hidden="true"
        />
      </Button>

      {open && (
        <ol id={listId} className="relative m-0 list-none p-0 mt-0.5">
          {rows.map((row, index) => {
            const status = rowStatus(row.status);
            const duration = status !== 'running' ? formatDuration(row.durationMs) : null;
            const isLast = index === rows.length - 1 && (!collapseMobileRows || showAll);
            return (
              <li
                key={row.id}
                className={`relative flex min-w-0 items-center gap-2 py-1 pl-5 leading-4 ${
                  collapseMobileRows && index < rows.length - 2 ? 'max-sm:hidden' : ''
                }`}
              >
                {/* 树状竖向导轨线：精准对齐顶层父级图标中心（7.5px） */}
                <span
                  aria-hidden="true"
                  className={`absolute left-[7.5px] top-0 w-px bg-slate-200 ${isLast ? 'h-1/2' : 'h-full'}`}
                />
                {/* 树状横向分支线：自导轨引向二级子项 */}
                <span
                  aria-hidden="true"
                  className="absolute left-[7.5px] top-1/2 w-2.5 h-px bg-slate-200"
                />
                <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-slate-50 text-slate-500 ring-1 ring-slate-200/80">
                  <StatusIcon status={status} className="h-2.5 w-2.5" size={10} />
                </span>
                <span className={`min-w-0 flex-1 truncate text-[11px] ${status === 'running' ? 'font-medium text-slate-700' : 'text-slate-500'}`}>
                  {row.label}
                  {duration && <span className="ml-1.5 font-mono text-[10px] text-slate-400">· {duration}</span>}
                </span>
              </li>
            );
          })}
          {collapseMobileRows && (
            <li className="relative flex min-w-0 items-center py-1 pl-5 sm:hidden">
              <span aria-hidden="true" className="absolute left-[7.5px] top-0 h-1/2 w-px bg-slate-200" />
              <span aria-hidden="true" className="absolute left-[7.5px] top-1/2 w-2.5 h-px bg-slate-200" />
              <Button
                variant="plain"
                type="button"
                onClick={() => setShowAll(true)}
                className="p-0 text-[11px] text-slate-400 transition-colors hover:text-slate-600"
              >
                查看全部 {rows.length} 步
              </Button>
            </li>
          )}
        </ol>
      )}
    </section>
  );
}

