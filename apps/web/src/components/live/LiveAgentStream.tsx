// 生成直播的 AI 面板：主 Agent 里只出一个「旅行规划助手」节点，展开才是阶段时间线。
//
// 阶段行点击进入各自工作流页面；右侧行程/地图由 TripEditorPage 工作区继续渲染。
import { useMemo } from 'react';
import type { LiveStream } from '../../lib/liveAgentStream';
import { Button } from '../ui/Button';
import { PlannerNode, type PlannerStage } from './PlannerNode';

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
  const stages = useMemo<PlannerStage[]>(
    () => stream.phases.map((phase) => ({
      key: phase.key,
      label: phase.label,
      status: phase.status,
      href: `/agent/${jobId}/agents/${phase.key}`,
    })),
    [stream.phases, jobId],
  );
  const status = done ? 'done' as const
    : failed || cancelled ? 'error' as const
      : stream.phases.some((phase) => phase.running) || stream.phases.length === 0 ? 'running' as const
        : 'done' as const;

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
      <p className="mb-3 mt-0 text-sm leading-relaxed text-slate-600">
        正在为你规划{destination ? `「${destination}」` : ''}{days ? ` ${days} 天` : ''}行程，规划好的每天会直接出现在右边的行程和地图里。
      </p>
      <PlannerNode stages={stages} status={status} />
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
