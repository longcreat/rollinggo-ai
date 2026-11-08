// 主 Agent 里的唯一子 Agent 节点：默认只显示「旅行规划助手」+ 状态。
// 展开后是阶段时间线（查找地点与资料 / 规划每日行程 / 整理文案与建议），阶段行再进入各自工作流。
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { STATUS_LABEL, StatusIcon } from './liveStatus';

export interface PlannerStage {
  key: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  href: string;
}

export function PlannerNode({ stages, status, tripHref, from, defaultOpen = false, bare = false }: {
  stages: readonly PlannerStage[];
  status: 'pending' | 'running' | 'done' | 'error';
  tripHref?: string;
  /** 从对话进入阶段页时，返回来源页面。 */
  from?: string;
  defaultOpen?: boolean;
  /** 对话时间线里用无边框的简洁节点，而不是一张卡片。 */
  bare?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={bare ? 'min-w-0 text-xs text-slate-700' : 'min-w-0 rounded-xl border border-slate-200/80 bg-white/90 p-2.5 text-xs text-slate-700'}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`flex w-full min-w-0 items-center gap-2 text-left transition-colors ${bare ? 'rounded-md px-0.5 py-1 hover:text-slate-900' : 'rounded-lg px-1 py-0.5 hover:bg-slate-50'}`}
      >
        <StatusIcon running={status === 'running'} error={status === 'error'} done={status === 'done'} className="h-4 w-4" />
        <span className={`min-w-0 flex-1 truncate text-[13px] text-slate-800 ${bare ? 'font-medium' : 'font-semibold'}`}>旅行规划助手</span>
        <span className="shrink-0 text-[11px] text-slate-400">{STATUS_LABEL[status]}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-300 transition-transform ${open ? '' : '-rotate-90'}`} aria-hidden="true" />
      </button>
      {open && (
        <div className={bare ? 'mt-1 ml-6 border-l border-slate-200 pl-3' : 'mt-1.5 border-t border-slate-100 pt-1'}>
          {stages.length === 0 && <p className="m-0 px-1 py-1.5 text-[11px] text-slate-400">正在启动…</p>}
          {stages.map((stage) => (
            <Link
              key={stage.key}
              to={stage.href}
              state={from ? { from } : undefined}
              className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1.5 text-[11px] text-slate-500 no-underline transition-colors hover:bg-slate-50"
            >
              <StatusIcon
                running={stage.status === 'running'}
                error={stage.status === 'error'}
                done={stage.status === 'done'}
              />
              <span className="min-w-0 flex-1 truncate font-medium text-slate-600">{stage.label}</span>
              <span className="shrink-0 text-slate-400">{STATUS_LABEL[stage.status]}</span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-300" aria-hidden="true" />
            </Link>
          ))}
          {tripHref && (
            <Link to={tripHref} className="mt-1 flex w-full items-center justify-center rounded-lg px-1 py-1.5 text-[11px] font-medium text-brand no-underline hover:bg-brand/[0.06]">
              查看行程
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
