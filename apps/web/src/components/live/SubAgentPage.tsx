// 子 Agent 页面：只读展示某个生成阶段的工具流程。
//
// 运行中直接用主投影；刷新/终态/实时层过期后，按 jobId+stage 懒加载 durable 子会话记录。
// 极简：只有返回、标题、状态和步骤列表，不放大按钮、摘要或候选。
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { getPlannerStageDisplay } from '@rollinggo-trip/shared';
import { api } from '../../api/client';
import type { LivePhase, LiveStream } from '../../lib/liveAgentStream';
import { Button } from '../ui/Button';
import { STATUS_LABEL, StatusIcon } from './liveStatus';

interface TranscriptStep {
  id: string;
  label: string;
  status: 'running' | 'done' | 'error';
  durationMs?: number;
}

const TOOL_LABEL: Record<string, string> = {
  search_verified_places: '查询已验证地点',
  submit_research: '提交调研结果',
  list_areas: '查看片区',
  search_area_places: '检索片区地点',
  web_search: '全网搜索',
  plan_day: '规划当天',
  validate_plan: '校验规划',
  submit_plan: '提交规划',
  update_titles: '撰写标题',
  submit_trip_advice: '撰写旅行建议',
  search_pois: '搜索地点',
  search_food: '搜索餐厅',
  search_web: '全网搜索',
};

function toolLabel(name: string): string {
  return TOOL_LABEL[name] ?? name.replace(/_/g, ' ');
}

function phaseStepLabel(text: string): string {
  return text.replace(/^正在/, '').replace(/…$/, '').replace(/(完成|未完成)$/, '');
}

export function SubAgentPage({ jobId, stage, stream, onBack }: {
  jobId: string;
  stage: string;
  stream: LiveStream;
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
  const meta = getPlannerStageDisplay(stage);
  const title = meta.clientTitle;
  const status = phase?.status ?? (transcript.data?.running ? 'running' : 'done');
  const steps: TranscriptStep[] = phase
    ? phase.lines.map((line) => ({
      id: line.id,
      label: phaseStepLabel(line.text),
      status: line.error ? 'error' : line.running ? 'running' : 'done',
      ...(line.durationMs !== undefined ? { durationMs: line.durationMs } : {}),
    }))
    : (transcript.data?.steps ?? []).map((step) => ({ ...step, label: toolLabel(step.label) }));

  return <div className="flex min-h-0 flex-1 flex-col" data-subagent-page={stage}>
    <div className="shrink-0 border-b border-slate-100 px-4 py-3">
      <Button variant="plain" className="mb-2 gap-1.5 px-0 text-xs text-slate-500 hover:text-slate-800" onClick={onBack}>
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        返回主 Agent
      </Button>
      <h2 className="m-0 flex items-center gap-2 text-sm font-semibold text-slate-800">
        <StatusIcon running={status === 'running'} error={status === 'error'} done={status === 'done'} className="h-4 w-4" />
        <span className="min-w-0 truncate">{title}</span>
      </h2>
      <p className="mb-0 mt-0.5 text-[11px] text-slate-500">
        {meta.clientSubtitle}
      </p>
      <p className="mb-0 mt-1 text-[11px] text-slate-400">
        {STATUS_LABEL[status]}{steps.length > 0 ? ` · ${steps.filter((step) => step.status === 'done').length}/${steps.length} 步` : ''}
      </p>
    </div>

    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
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
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  </div>;
}
