// 对话里的生成任务卡（openmuse 的 Activity 精简版）：运行中看阶段/取消，完成看行程与摘要。
// 数据来自持久任务行，刷新/重启后仍能读到终态。
import { useNavigate } from 'react-router-dom';
import { useCancelGeneration, useGenerationTask } from '../../api/hooks';
import { Spinner } from '../ui/Button';

export function TaskCard({ jobId }: { jobId: string }) {
  const navigate = useNavigate();
  const task = useGenerationTask(jobId);
  const cancel = useCancelGeneration();
  const data = task.data;
  const status = data?.status ?? 'running';
  const running = status === 'running';
  const title = data?.destination
    ? `${data.destination}${data.days ? ` · ${data.days} 天` : ''}`
    : '行程生成';
  const warnings = data?.warnings ?? [];
  const hard = warnings.filter((warning) => warning.severity === 'hard').length;

  return (
    <div className="mt-2 rounded-2xl border border-slate-200/90 bg-white/95 p-3 text-xs text-slate-700 shadow-2xs">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 font-medium text-slate-900">
          {running && <span className="grid h-3.5 w-3.5 shrink-0 place-items-center"><Spinner /></span>}
          <span className="truncate">{title}</span>
          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-normal text-slate-500">
            {running ? '生成中' : status === 'done' ? '已生成' : status === 'cancelled' ? '已取消' : '未完成'}
          </span>
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {running && (
            <button
              type="button"
              className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(jobId)}
            >
              {cancel.isPending ? '取消中…' : '取消'}
            </button>
          )}
          {status !== 'done' && (
            <button
              type="button"
              className="rounded-full border border-brand/20 bg-brand/[0.07] px-2.5 py-1 text-[11px] font-medium text-brand hover:bg-brand/10"
              onClick={() => navigate(`/agent/${encodeURIComponent(jobId)}`)}
            >
              查看进度
            </button>
          )}
          {status === 'done' && data?.tripId && (
            <button
              type="button"
              className="rounded-full bg-brand px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90"
              onClick={() => navigate(`/trips/${encodeURIComponent(data.tripId!)}`)}
            >
              查看行程
            </button>
          )}
        </div>
      </div>
      {running && data?.phase && (
        <p className="mb-0 mt-2 text-[11px] text-slate-500">
          当前阶段：{data.phase}
          {data.steps?.length ? `｜${data.steps.slice(-3).join('、')}` : ''}
        </p>
      )}
      {!running && (data?.summary || data?.reviewNotes?.length || warnings.length > 0 || data?.message) && (
        <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-slate-500">
          {data?.message && <p className="m-0 text-rose-600">{data.message}</p>}
          {data?.summary && <p className="m-0">{data.summary}</p>}
          {data?.reviewNotes?.length ? <p className="m-0">提醒 {data.reviewNotes.length} 条：{data.reviewNotes.slice(0, 2).join('；')}</p> : null}
          {warnings.length > 0 && <p className="m-0">{hard > 0 ? `硬冲突 ${hard} 条` : `优化建议 ${warnings.length} 条`}</p>}
        </div>
      )}
    </div>
  );
}
