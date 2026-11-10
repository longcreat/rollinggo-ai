// 正在进行的这一问一答（10-23）：按事件顺序渲染正文段与工具段，HITL 问题卡固定在输入框上方。
// 单独成组件是为了让流式快照只重渲染这一块，历史消息靠 MessageBubble 的 memo 挡住。
import type { AgentPart, AgentQuestionAnswer, DetailChatRequest, PendingQuestionView } from '@rollinggo-trip/shared';
import { Button } from '../ui/Button';
import { AgentActivity } from './AgentActivity';
import { ChatText } from './ChatText';
import { ThinkingRow } from './ThinkingRow';
import { RotateCcw, SquarePen } from 'lucide-react';

export interface PendingExchange<T extends { text: string } = DetailChatRequest> {
  input: T;
  /** 正文段与工具段按真实事件顺序排列 */
  parts: AgentPart[];
  /** 当前最后一段正文是否仍在流式增长；工具/问题出现后关闭 */
  textOpen: boolean;
  state: 'running' | 'stopped' | 'error';
  /** HITL：Agent 在工具中暂停时的问题；回答后同一回合继续 */
  question?: PendingQuestionView;
  questionState?: 'pending' | 'answered' | 'expired';
  questionExpiredReason?: 'timeout' | 'cancelled';
  questionAnswers?: AgentQuestionAnswer[];
}

export function PendingAnswer({ pending, busy, readOnly, onRetry, onRestore }: {
  pending: PendingExchange<{ text: string }>;
  busy: boolean;
  readOnly: boolean;
  onRetry: () => void;
  onRestore?: () => void;
}) {
  const running = pending.state === 'running';
  const lastSteps = pending.parts.map((part, index) => part.type === 'steps' ? index : -1).filter((index) => index >= 0).at(-1);
  const hasSteps = lastSteps !== undefined;
  return <>
    <div className="chat-bubble self-end max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-slate-900 text-white px-3.5 py-2.5 text-sm shadow-2xs">{pending.input.text}</div>
    <div className="min-w-0">
      {pending.parts.map((part, index) => part.type === 'thinking'
        ? <ThinkingRow key={`thinking-${index}`} thinking={part} />
        : part.type === 'text'
          ? <div key={`text-${index}`} className="mb-1.5 break-words px-1 py-0.5 text-sm leading-relaxed text-slate-800"><ChatText text={part.text} markdown /></div>
          : part.type === 'steps' ? <AgentActivity key={`steps-${index}`} steps={part.steps}
            state={index !== lastSteps ? 'completed' : running && index === pending.parts.length - 1 ? 'running' : running ? 'completed' : pending.state} />
          : null)}
      {!running && (
        <div className="mt-2 flex items-center gap-2 text-slate-400 px-1">
          {!hasSteps && <span className="text-xs text-slate-400">{pending.state === 'stopped' ? '已停止' : '回答中断'}</span>}
          <Button
            variant="plain"
            type="button"
            disabled={busy || readOnly}
            onClick={onRetry}
            aria-label="重试"
            title="重试"
            className="p-0 text-slate-400 hover:text-slate-700 transition-colors disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          {onRestore && (
            <Button
              variant="plain"
              type="button"
              onClick={onRestore}
              aria-label="恢复编辑"
              title="恢复编辑"
              className="p-0 text-slate-400 hover:text-slate-700 transition-colors"
            >
              <SquarePen className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
    </div>
  </>;
}
