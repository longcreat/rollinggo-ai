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

export function PlannerNode({ stages, status, from, defaultOpen = false, bare = false }: {
  stages: readonly PlannerStage[];
  status: 'pending' | 'running' | 'done' | 'error';
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
        className={`group flex w-full min-w-0 items-center gap-2 text-left transition-colors ${bare ? 'rounded-md px-0.5 py-1 hover:text-slate-900' : 'rounded-lg px-1 py-0.5 hover:bg-slate-50'}`}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 transition-colors group-hover:border-slate-300 group-hover:text-slate-600">
          <ChevronDown className={`h-2.5 w-2.5 transition-transform motion-reduce:transition-none ${open ? '' : '-rotate-90'}`} aria-hidden="true" />
        </span>
        <span className={`min-w-0 flex-1 truncate text-[13px] text-slate-800 ${bare ? 'font-medium' : 'font-semibold'}`}>旅行规划助手</span>
        <span className="shrink-0 text-[11px] text-slate-400">{STATUS_LABEL[status]}</span>
      </button>
      {open && (
        <div className={bare ? 'mt-1 ml-6' : 'mt-2 border-t border-slate-100 pt-1'}>
          {stages.length === 0 && <p className="m-0 px-1 py-1.5 text-[11px] text-slate-400">正在启动…</p>}
          <ol className="relative m-0 list-none p-0">
            {stages.map((stage, index) => (
              <li key={stage.key} className="relative">
                {/* 时间线：最后一个阶段只画到节点中心，避免线尾悬空。 */}
                <span
                  aria-hidden="true"
                  className={`absolute left-[7.5px] top-0 w-px bg-slate-200 ${index === stages.length - 1 ? 'h-1/2' : 'h-full'}`}
                />
                <Link
                  to={stage.href}
                  state={from ? { from } : undefined}
                  className="relative flex min-w-0 items-center gap-2 rounded-lg py-1.5 pr-1 text-[11px] text-slate-500 no-underline transition-colors hover:bg-slate-50"
                >
                  <span className="relative z-10 flex h-4 w-4 shrink-0 items-center justify-center bg-white">
                    <StatusIcon
                      running={stage.status === 'running'}
                      error={stage.status === 'error'}
                      done={stage.status === 'done'}
                    />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium text-slate-600">{stage.label}</span>
                  <span className="shrink-0 text-slate-400">{STATUS_LABEL[stage.status]}</span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-300" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
