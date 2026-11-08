// 真实思考面板：只在模型返回 thinking 时出现；只展示状态与规模，不渲染原始 CoT。
import { Brain, LoaderCircle } from 'lucide-react';

export interface ThinkingView {
  active: boolean;
  chunks: number;
  durationMs?: number;
  startedAt?: number;
  endedAt?: number;
}

export function ThinkingPanel({ thinking }: { thinking: ThinkingView }) {
  const durationMs = thinking.durationMs
    ?? (thinking.startedAt !== undefined ? (thinking.endedAt ?? Date.now()) - thinking.startedAt : undefined);
  const seconds = durationMs !== undefined ? Math.max(1, Math.round(durationMs / 1000)) : null;
  return (
    <details className="mb-1.5 rounded-xl border border-slate-200/80 bg-slate-50/50 px-3 py-2 text-xs text-slate-500">
      <summary className="flex cursor-pointer select-none list-none items-center gap-1.5">
        <Brain className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
        <span>{thinking.active ? '正在思考…' : seconds ? `思考了约 ${seconds} 秒` : '思考完成'}</span>
        {thinking.active && <LoaderCircle className="h-3 w-3 animate-spin text-slate-400 motion-reduce:animate-none" aria-hidden="true" />}
      </summary>
      <p className="m-0 mt-1.5 leading-relaxed">
        {thinking.chunks > 0
          ? `模型返回了 ${thinking.chunks} 段推理；原始思考内容不展示。`
          : '这次回答没有可展示的思考摘要。'}
      </p>
    </details>
  );
}
