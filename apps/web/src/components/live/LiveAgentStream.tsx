// 生成直播的 AI 面板：子 Agent 条目内联在主 Agent 时间线里。
//
// 对齐 Qoder/opencode：条目只显示标题、状态、耗时、步数；点击整行进入该子 Agent 页面，
// 结果摘要与完整工具流程留在子页面。默认始终停留在主 Agent 页面。
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import type { LivePhase, LiveStream } from '../../lib/liveAgentStream';
import { Button } from '../ui/Button';
import { durationText, STATUS_LABEL, StatusIcon } from './liveStatus';

function PhaseRow({ phase, jobId }: { phase: LivePhase; jobId: string }) {
  const percent = phase.total > 0 ? Math.round((phase.completed / phase.total) * 100) : 0;
  const duration = durationText(phase.durationMs);
  return (
    <Link
      to={`/agent/${jobId}/agents/${phase.key}`}
      data-subagent-row={phase.key}
      aria-label={`进入「${phase.label}」子 Agent 页面，${STATUS_LABEL[phase.status]}${phase.total > 0 ? `，${phase.completed}/${phase.total} 步` : ''}`}
      className="mb-2 block w-full min-w-0 rounded-2xl border border-slate-200/90 bg-white/95 p-3 text-left shadow-2xs no-underline transition-colors last:mb-0 hover:bg-slate-50/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
    >
      <span className="flex items-center gap-2.5">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-xl ${
          phase.error ? 'bg-rose-50 text-rose-500' : phase.done ? 'bg-emerald-50 text-emerald-600' : 'bg-sky-50 text-sky-600'
        }`}>
          <StatusIcon running={phase.running} error={phase.error} done={phase.done} className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-slate-800">{phase.label}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
            <span>{STATUS_LABEL[phase.status]}</span>
            {phase.total > 0 && <span>· {phase.completed}/{phase.total} 步</span>}
            {duration && <span>· {duration}</span>}
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" aria-hidden="true" />
      </span>
      {phase.total > 0 && (
        <span className="mt-2 block h-1 overflow-hidden rounded-full bg-slate-100">
          <span
            className={`block h-full rounded-full transition-[width] duration-300 ${phase.error ? 'bg-rose-400' : 'bg-sky-400'}`}
            style={{ width: `${percent}%` }}
          />
        </span>
      )}
    </Link>
  );
}

export function LiveAgentStream({ jobId, stream, destination, days, cancelling, error, lost, onCancel, onHome, onTrip, onRetry }: {
  jobId: string;
  stream: LiveStream;
  destination: string;
  days?: number;
  cancelling: boolean;
  error: string | null;
  lost: boolean;
  onCancel: () => void;
  onHome: () => void;
  /** 完成但用户主动留在主时间线时（从子页面返回）的出口。 */
  onTrip?: () => void;
  /** 失败后原地重试；缺省时只显示回首页。 */
  onRetry?: () => void;
}) {
  const done = stream.terminal?.type === 'job_done';
  const cancelled = stream.terminal?.type === 'job_cancelled';
  const failed = stream.terminal?.type === 'job_error';
  const finished = done || cancelled || failed;
  // 顶部只放一句「当前在哪个阶段」；每个子 Agent 的细节由下面的条目承载。
  const currentPhase = [...stream.phases].reverse().find((phase) => phase.running) ?? stream.phases.at(-1);
  const status = done
    ? '行程已生成'
    : cancelled
      ? '已停止生成'
      : failed
        ? '生成未完成'
        : stream.phases.length === 0
          ? '正在准备生成…'
          : stream.active && currentPhase
            ? `正在${currentPhase.label}…`
            : null;

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
      <div className="chat-bubble mb-3 break-words rounded-2xl bg-slate-50/90 px-3.5 py-2.5 text-sm leading-relaxed text-slate-800">
        <p className="m-0">正在为你规划{destination ? `「${destination}」` : ''}{days ? ` ${days} 天` : ''}行程，规划好的每天会直接出现在右边的行程和地图里。</p>
        {status && (
          <p className="mb-0 mt-1.5 flex items-center gap-1.5 text-xs text-slate-500">
            <StatusIcon running={!finished} done={done} error={failed} />{status}
          </p>
        )}
      </div>

      {stream.phases.map((phase) => (
        <PhaseRow key={phase.key} phase={phase} jobId={jobId} />
      ))}
    </div>

    <div className="shrink-0 border-t border-slate-100 px-4 py-3">
      {error && <p className="mb-2 mt-0 text-xs text-[var(--color-danger)]" role="alert">{error}</p>}
      {failed && (
        <p className="mb-2 mt-0 text-xs text-slate-500">
          这次没有排成功，行程还没有保存。可以直接重试，或回首页调整条件后再说一次。
        </p>
      )}
      {/* 终态（完成/停止/失败）不再给停止按钮：对已结束的任务点停止只会报「无法取消」。
          失败时留在本页给「重试」——回首页等于让用户重填一遍，是这次最伤体验的一步。 */}
      {failed && onRetry ? (
        <div className="flex flex-col gap-2">
          <Button className="w-full justify-center" onClick={onRetry}>重新生成一次</Button>
          <Button variant="ghost" className="w-full justify-center" onClick={onHome}>回首页调整条件</Button>
        </div>
      ) : lost || failed ? (
        <Button variant="secondary" className="w-full justify-center" onClick={onHome}>回首页</Button>
      ) : done && onTrip ? (
        <Button className="w-full justify-center" onClick={onTrip}>查看行程</Button>
      ) : finished ? null : (
        <Button variant="secondary" className="w-full justify-center" disabled={cancelling} onClick={onCancel}>
          {cancelling ? '正在停止…' : '停止生成'}
        </Button>
      )}
    </div>
  </div>;
}
