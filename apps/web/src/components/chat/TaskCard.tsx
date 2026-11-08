// 对话里的生成任务节点：主 Agent 只展示一个「旅行规划助手」，展开才是阶段时间线。
// 不展示摘要、步数或耗时；结果与详情在阶段页/行程页。
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { keys, useCancelGeneration, useGenerationAgents, useGenerationTask } from '../../api/hooks';
import { PlannerNode, type PlannerStage } from '../live/PlannerNode';

export function TaskCard({ jobId, conversationId }: { jobId: string; conversationId?: string }) {
  const location = useLocation();
  const qc = useQueryClient();
  const task = useGenerationTask(jobId);
  const cancel = useCancelGeneration();
  const data = task.data;
  const status = data?.status ?? 'running';
  const running = status === 'running';
  const agents = useGenerationAgents(jobId, running);
  const from = location.pathname + location.search;
  useEffect(() => {
    if (!conversationId || status === 'running') return;
    void qc.invalidateQueries({ queryKey: keys.conversation(conversationId) });
  }, [conversationId, status, qc]);

  const stages: PlannerStage[] = (agents.data?.agents ?? []).map((agent) => ({
    key: agent.stage,
    label: agent.label,
    status: agent.status,
    href: `/agent/${encodeURIComponent(jobId)}/agents/${agent.stage}`,
  }));
  const nodeStatus = status === 'done' ? 'done' : status === 'running' ? 'running' : 'error';

  return (
    <div className="mt-2" data-chat-planner={jobId}>
      <PlannerNode
        stages={stages}
        status={nodeStatus}
        from={from}
        {...(status === 'done' && data?.tripId ? { tripHref: `/trips/${encodeURIComponent(data.tripId)}` } : {})}
      />
      {running && (
        <button
          type="button"
          className="mt-1 px-1 text-[11px] text-slate-400 hover:text-slate-600"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate(jobId)}
        >
          {cancel.isPending ? '取消中…' : '取消生成'}
        </button>
      )}
    </div>
  );
}
