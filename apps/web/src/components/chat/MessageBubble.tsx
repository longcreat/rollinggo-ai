import { memo, useState } from 'react';
import type { ChatMessage } from '@tripweaver/shared';
import { ChatText } from './ChatText';
import { ChatProgress } from './ChatProgress';

interface Props {
  message: ChatMessage;
}

export const MessageBubble = memo(function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`chat-msg flex min-w-0 flex-col gap-1.5 ${isUser ? 'chat-msg-user ml-auto max-w-[85%] items-end' : 'chat-msg-assistant w-full items-start'}`}>
      {message.attachment && <ChatProgress steps={message.attachment.summary} />}
      <div className={`chat-bubble whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
        isUser
          ? 'bg-slate-900 text-white shadow-2xs'
          : 'bg-slate-50/90 text-slate-800'
      }`}>
        <ChatText text={message.content} />
        {!isUser && (
          <div className="flex items-center gap-3 pt-2 mt-2 text-slate-400 text-xs border-t border-slate-200/60">
            <button
              type="button"
              onClick={handleCopy}
              className="hover:text-slate-700 transition-colors cursor-pointer"
              title="复制回答"
            >
              {copied ? '已复制' : '复制'}
            </button>
          </div>
        )}
      </div>
      {!isUser && Boolean(message.attachment?.references?.some((source) => /^https?:\/\//i.test(source.url))) && (
        <details className="w-full rounded-xl border border-slate-200/70 bg-slate-50/50 px-3 py-1.5 text-xs text-slate-600">
          <summary className="cursor-pointer py-1 font-medium">参考资料</summary>
          <ul className="mt-1 space-y-1">
            {message.attachment?.references?.filter((source) => /^https?:\/\//i.test(source.url)).map((source) => (
              <li key={source.url}>
                <a href={source.url} target="_blank" rel="noopener noreferrer" className="block break-words py-0.5 text-slate-700 underline underline-offset-2 hover:text-slate-950">
                  {source.title || '查看来源'}
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
});
