// 主 Agent 里的专业规划子代理节点（TripPlannerAgent）
// 沉浸式旅行体验设计：提供富含旅行温度与仪式感的优雅文案、动态灵感微光条与五阶推演时间线。
// 遵循黑白极简与 Soft Radar 规范，拒绝机械化工程日志，让用户在等待中充满期待与情绪价值。
import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Compass, ShieldCheck, CloudSun, Route, Sparkles } from 'lucide-react';
import { getPlannerStageDisplay, type PlannerHighlightTicker } from '@rollinggo-trip/shared';
import { STATUS_LABEL, StatusIcon } from './liveStatus';
import { SoftRadar } from '../ui/SoftRadar';

export interface PlannerStage {
  key: string;
  label: string;
  rawLabel?: string;
  subtitle?: string;
  highlight?: string;
  status: 'pending' | 'running' | 'done' | 'error';
  href: string;
}

export function PlannerNode({
  stages,
  status,
  highlights = [],
  from,
  defaultOpen = false,
  bare = false,
}: {
  stages: readonly PlannerStage[];
  status: 'pending' | 'running' | 'done' | 'error';
  highlights?: readonly PlannerHighlightTicker[];
  from?: string;
  defaultOpen?: boolean;
  bare?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // 获取当前正在执行或最近完成的阶段
  const activeStage = useMemo(() => {
    return stages.find((s) => s.status === 'running') ?? [...stages].reverse().find((s) => s.status === 'done') ?? stages[0];
  }, [stages]);

  // 最新捕获到的灵感高光点
  const latestHighlight = useMemo(() => {
    if (highlights.length > 0) {
      return highlights[highlights.length - 1];
    }
    return null;
  }, [highlights]);

  // 渲染阶段图标
  const renderStageIcon = (key: string, stageStatus: string) => {
    const meta = getPlannerStageDisplay(key);
    const iconClass = stageStatus === 'running' ? 'text-slate-900 animate-pulse' : stageStatus === 'done' ? 'text-slate-600' : 'text-slate-300';
    switch (meta.iconType) {
      case 'compass':
        return <Compass className={`h-3.5 w-3.5 ${iconClass}`} />;
      case 'shield':
        return <ShieldCheck className={`h-3.5 w-3.5 ${iconClass}`} />;
      case 'cloud-sun':
        return <CloudSun className={`h-3.5 w-3.5 ${iconClass}`} />;
      case 'route':
        return <Route className={`h-3.5 w-3.5 ${iconClass}`} />;
      case 'sparkles':
      default:
        return <Sparkles className={`h-3.5 w-3.5 ${iconClass}`} />;
    }
  };

  return (
    <div
      className={
        bare
          ? 'min-w-0 text-xs text-slate-700'
          : 'min-w-0 rounded-2xl border border-slate-200/90 bg-gradient-to-b from-white to-slate-50/60 p-3 shadow-xs text-xs text-slate-700 transition-all'
      }
    >
      {/* 头部摘要栏 */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`group flex w-full min-w-0 items-start gap-2.5 text-left transition-colors ${
          bare ? 'rounded-md px-0 py-1 hover:text-slate-900' : 'rounded-xl p-1.5 hover:bg-slate-100/70'
        }`}
      >
        <div className="flex h-5 w-5 shrink-0 items-center justify-center">
          {status === 'running' ? (
            <SoftRadar size={15} className="text-slate-900" />
          ) : (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-slate-100 text-slate-700">
              <Sparkles className="h-2.5 w-2.5" />
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex h-5 items-center gap-2">
            <span className={`truncate text-xs ${bare ? 'font-medium' : 'font-semibold text-slate-900'}`}>
              旅行规划助手 · TripPlannerAgent
            </span>
            <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono text-slate-500">
              {status === 'running' ? '深度推演中' : status === 'done' ? '行程已成案' : STATUS_LABEL[status]}
            </span>
          </div>

          {/* 实时动态文案：运行中时展示富有期待感的灵感流动提示 */}
          {status === 'running' && (
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-slate-400 animate-ping" />
              <span className="truncate">
                {latestHighlight?.text ?? activeStage?.highlight ?? activeStage?.subtitle ?? '正在融合全网旅行攻略与真实口碑定制行程…'}
              </span>
            </div>
          )}
        </div>

        <div className="flex h-5 shrink-0 items-center">
          <ChevronDown
            className={`h-3.5 w-3.5 text-slate-400 transition-transform duration-200 group-hover:text-slate-600 ${
              open ? '' : '-rotate-90'
            }`}
            aria-hidden="true"
          />
        </div>
      </button>

      {/* 展开内容：五阶推演时间线 */}
      {open && (
        <div className={bare ? 'mt-2 ml-5 border-l border-slate-200/80 pl-3' : 'mt-2.5 border-t border-slate-100/90 pt-2.5'}>
          {stages.length === 0 && (
            <p className="m-0 px-1 py-1.5 text-[11px] text-slate-400">正在准备规划沙盒上下文…</p>
          )}

          <ol className="relative m-0 list-none p-0 space-y-1">
            {stages.map((stage) => {
              const meta = getPlannerStageDisplay(stage.key);
              const isRunning = stage.status === 'running';
              const isDone = stage.status === 'done';

              return (
                <li key={stage.key} className="relative">
                  <Link
                    to={stage.href}
                    state={from ? { from } : undefined}
                    className={`group/item relative flex min-w-0 flex-col rounded-xl p-2 text-[11px] no-underline transition-all ${
                      isRunning
                        ? 'bg-white shadow-xs border border-slate-200/80 text-slate-900'
                        : 'text-slate-600 hover:bg-white/80'
                    }`}
                  >
                    {/* 第一行：图标 + 标题 + 状态标签 + 箭头（绝对垂直居中对齐） */}
                    <div className="flex w-full min-w-0 items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-slate-600">
                          {renderStageIcon(stage.key, stage.status)}
                        </span>
                        <span className={`truncate text-xs ${isRunning ? 'font-semibold text-slate-900' : isDone ? 'font-medium text-slate-800' : 'text-slate-400'}`}>
                          {stage.label || meta.clientTitle}
                        </span>
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        <span className="text-[10px] font-mono text-slate-400">
                          {STATUS_LABEL[stage.status]}
                        </span>
                        <ChevronRight className="h-3 w-3 text-slate-300 transition-transform group-hover/item:translate-x-0.5 group-hover/item:text-slate-500" aria-hidden="true" />
                      </div>
                    </div>

                    {/* 第二行：极简副标题（左侧缩进 pl-6 与第一行标题文字平齐） */}
                    <p className="m-0 mt-0.5 pl-6 line-clamp-1 text-[11px] text-slate-400 group-hover/item:text-slate-500">
                      {stage.subtitle || meta.clientSubtitle}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
