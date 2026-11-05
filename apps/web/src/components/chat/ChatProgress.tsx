import { useState } from 'react';
import { Compass } from 'lucide-react';

interface Props {
  steps: string[];
  state?: 'running' | 'stopped' | 'error' | 'completed';
}

/** 过程来自服务端真实阶段事件；与正文分开，完成后仍可展开回看。 */
export function ChatProgress({ steps, state = 'completed' }: Props) {
  const running = state === 'running';
  const [expanded, setExpanded] = useState(running);
  if (!steps.length) return null;
  const status = running ? '处理中' : state === 'stopped' ? '已停止' : state === 'error' ? '已中断' : '已完成';
  return (
    <details className="group chat-progress mb-2 w-full min-w-0 rounded-xl border border-slate-200/70 bg-slate-50/50 px-3 py-1 text-xs text-slate-500" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="flex h-7 cursor-pointer list-none items-center gap-2 py-0 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        <span className={running ? 'text-slate-700 motion-safe:animate-spin' : 'text-slate-700'} aria-hidden="true">
          <Compass className="w-3.5 h-3.5" />
        </span>
        <span className="min-w-0 flex-1 text-xs font-medium text-slate-700">
          思考过程 <span className="font-normal text-slate-400">· {status} · {steps.length} 步</span>
        </span>
        <svg className="transition-transform group-open:rotate-180 text-slate-400" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </summary>
      <ol className="mb-2 mt-1 list-none space-y-1.5 border-0 border-l border-solid border-slate-200 pl-3 text-xs text-slate-600">
        {steps.map((step, index) => (
          <li key={index} className="relative break-words leading-relaxed pl-1">
            <span aria-hidden="true" className={`absolute -left-[16px] top-2 h-1.5 w-1.5 rounded-full ${running && index === steps.length - 1 ? 'bg-slate-900 motion-safe:animate-pulse' : 'bg-slate-300'}`} />
            {step}
          </li>
        ))}
      </ol>
    </details>
  );
}
