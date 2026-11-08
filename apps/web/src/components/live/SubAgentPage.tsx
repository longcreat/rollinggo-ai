// 子 Agent 页面：只读展示某个生成阶段的完整工作流。
//
// 运行中直接用主投影（步骤最新）；刷新/终态/实时层过期后，按 jobId+stage 懒加载 durable 子会话记录。
// 页面只换左栏，右侧行程与地图仍由 TripEditorPage 工作区保留；顶部返回主 Agent 时间线。
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ListChecks } from 'lucide-react';
import { api } from '../../api/client';
import type { LivePhase, LiveStream } from '../../lib/liveAgentStream';
import { Button } from '../ui/Button';
import { durationText, STATUS_LABEL, StatusIcon } from './liveStatus';

interface TranscriptStep {
  id: string;
  label: string;
  status: 'running' | 'done' | 'error';
  durationMs?: number;
}

const STAGE_LABEL: Record<string, string> = {
  research: '查找地点与资料',
  plan: '规划每日行程',
  review: '整理文案与建议',
};

function phaseSummary(phase: LivePhase): string {
  if (phase.running) return phase.current ?? '正在处理…';
  if (phase.error) return phase.summary ?? '这一步没有完成';
  if (phase.done) return phase.summary ?? `${phase.completed} 步已完成`;
  return '等待开始';
}

export function SubAgentPage({ jobId, stage, stream, completedTripId, onTrip, onBack }: {
  jobId: string;
  stage: string;
  stream: LiveStream;
  /** 任务已完成时保留子页面，给一个明确的查看行程出口。 */
  completedTripId?: string | null;
  onTrip?: () => void;
  onBack: () => void;
}) {
  const phase = stream.phases.find((item) => item.key === stage);
  // 只有投影里没有这个阶段（刷新/终态过期/重启）才读 durable 子会话，避免运行中重复请求。
  const transcript = useQuery({
    queryKey: ['generation-agent', jobId, stage],
    queryFn: () => api.get<{ steps: TranscriptStep[]; running: boolean }>(`/api/generations/${jobId}/agents/${stage}`),
    enabled: !phase,
    staleTime: 15_000,
  });
  const title = phase?.label ?? STAGE_LABEL[stage] ?? stage;
  const status = phase?.status ?? (transcript.data?.running ? 'running' : 'done');
  const steps: TranscriptStep[] = phase
    ? phase.lines.map((line) => ({
      id: line.id,
      label: line.text,
      status: line.error ? 'error' : line.running ? 'running' : 'done',
      ...(line.durationMs !== undefined ? { durationMs: line.durationMs } : {}),
    }))
    : transcript.data?.steps ?? [];
  const duration = durationText(phase?.durationMs);

  return <div className="flex min-h-0 flex-1 flex-col" data-subagent-page={stage}>
    <div className="shrink-0 border-b border-slate-100 px-4 py-3">
      <Button variant="plain" className="mb-2 gap-1.5 px-0 text-xs text-slate-500 hover:text-slate-800" onClick={onBack}>
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        返回主 Agent
      </Button>
      <h2 className="m-0 flex items-center gap-2 text-sm font-semibold text-slate-800">
        <StatusIcon running={status === 'running'} error={status === 'error'} done={status === 'done'} className="h-4 w-4" />
        <span className="min-w-0 truncate">{title}</span>
        <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-normal text-slate-500">子 Agent</span>
      </h2>
      <p className="mb-0 mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
        <span>{STATUS_LABEL[status]}</span>
        {steps.length > 0 && <span>· {steps.filter((step) => step.status === 'done').length}/{steps.length} 步</span>}
        {duration && <span>· 用时 {duration}</span>}
      </p>
      {completedTripId && onTrip && (
        <Button variant="secondary" className="mt-2 w-full justify-center" onClick={onTrip}>行程已生成，查看行程</Button>
      )}
    </div>

    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
      {phase && (
        <p className="m-0 mb-3 rounded-xl bg-slate-50 px-3 py-2 text-[13px] leading-relaxed text-slate-600">
          {phaseSummary(phase)}
        </p>
      )}
      <section>
        <h3 className="m-0 mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-500">
          <ListChecks className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
          工作流程
        </h3>
        {transcript.isPending && !phase && <p className="m-0 text-xs text-slate-400">正在读取子 Agent 记录…</p>}
        {transcript.isError && !phase && <p className="m-0 text-xs text-rose-500" role="alert">子 Agent 记录暂时不可用</p>}
        {!transcript.isPending && !transcript.isError && steps.length === 0 && (
          <p className="m-0 text-xs text-slate-400">还没有可展示的步骤。</p>
        )}
        {steps.length > 0 && (
          <ol className="m-0 list-none space-y-1.5 p-0">
            {steps.map((step) => (
              <li key={step.id} className="flex items-start gap-2 text-xs leading-5">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                  <StatusIcon running={step.status === 'running'} error={step.status === 'error'} done={step.status === 'done'} />
                </span>
                <span className={`min-w-0 flex-1 break-words ${step.status === 'running' ? 'font-medium text-slate-700' : 'text-slate-500'}`}>
                  {step.label}
                  {durationText(step.durationMs) && <span className="ml-1 text-slate-400">· {durationText(step.durationMs)}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  </div>;
}
