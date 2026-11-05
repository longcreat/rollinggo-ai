// 正在进行的这一问一答（10-23）：流式正文、工具步骤、停止/重试/恢复编辑。
// 单独成组件是为了让 answer_delta 的 setState 只重渲染这一块，历史消息靠 MessageBubble 的 memo 挡住。
import type { DetailChatRequest } from '@tripweaver/shared';
import { Button } from '../ui/Button';
import { ChatProgress } from './ChatProgress';
import { ChatText } from './ChatText';

export interface PendingExchange {
  input: DetailChatRequest;
  text: string;
  summary: string[];
  state: 'running' | 'stopped' | 'error';
}

export function PendingAnswer({ pending, busy, readOnly, onRetry, onRestore }: {
  pending: PendingExchange;
  busy: boolean;
  readOnly: boolean;
  onRetry: () => void;
  onRestore: () => void;
}) {
  const running = pending.state === 'running';
  return <>
    <div className="chat-bubble self-end max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-slate-900 text-white px-3.5 py-2.5 text-sm shadow-2xs">{pending.input.text}</div>
    <div className="min-w-0">
      <ChatProgress key={`${pending.input.requestId}:${pending.state}`} steps={pending.summary} state={pending.state} />
      <div className="chat-bubble whitespace-pre-wrap break-words rounded-2xl bg-slate-50/90 px-3.5 py-2.5 text-sm leading-relaxed text-slate-800"><ChatText text={pending.text || (running ? '正在准备回答…' : '')} /></div>
      {!running && <div className="mt-2 flex flex-wrap items-center gap-2"><span className="text-xs text-slate-400">{pending.state === 'stopped' ? '已停止' : '回答中断'}</span><Button variant="ghost" className="text-xs" disabled={busy || readOnly} onClick={onRetry}>重试</Button><Button variant="ghost" className="text-xs" onClick={onRestore}>恢复编辑</Button></div>}
    </div>
  </>;
}
