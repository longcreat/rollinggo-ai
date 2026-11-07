import { memo, useState } from 'react';
import type { ChatMessage } from '@tripweaver/shared';
import { Check, Copy } from 'lucide-react';
import { Button } from '../ui/Button';
import { ChatText } from './ChatText';

interface Props {
  message: ChatMessage;
  /** 正文被拆成多个片段时，复制仍取完整回答 */
  copyText?: string;
  /** 撤销本轮改动：回到改动前的版本 */
  onUndo?: (previousTripId: string) => void | Promise<void>;
  undoing?: boolean;
  /** 只有当前版本对应的那次修改允许撤销；历史消息不再提供撤销，避免反复从旧版本建新版本 */
  canUndo?: boolean;
  /** 这次修改产生的版本是否还在链上；回退后为 false */
  editExists?: boolean;
}

export const MessageBubble = memo(function MessageBubble({ message, copyText, onUndo, undoing = false, canUndo = true, editExists = true }: Props) {
  const isUser = message.role === 'user';
  const edit = message.attachment?.edit;
  const [copied, setCopied] = useState(false);
  const [showEdits, setShowEdits] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(copyText ?? message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`chat-msg flex min-w-0 flex-col gap-1.5 ${isUser ? 'chat-msg-user ml-auto max-w-[85%] items-end' : 'chat-msg-assistant w-full items-start'}`}>
      <div className={`chat-bubble break-words rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
        isUser
          ? 'whitespace-pre-wrap bg-slate-900 text-white shadow-2xs'
          : 'bg-slate-50/90 text-slate-800'
      }`}>
        <ChatText text={message.content} markdown={!isUser} />
      </div>
      {!isUser && (
        <div className="flex items-center px-1 text-slate-400">
          <Button
            variant="plain"
            type="button"
            onClick={handleCopy}
            aria-label={copied ? '已复制' : '复制回答'}
            title={copied ? '已复制' : '复制回答'}
            className="p-0 hover:text-slate-700"
          >
            {copied
              ? <Check className="h-3.5 w-3.5" aria-hidden="true" />
              : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
          </Button>
        </div>
      )}
      {!isUser && edit && editExists && (
        <div className="mt-1 w-full">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 text-slate-500">
              <span className="text-emerald-600" aria-hidden="true">✓</span>
              v{edit.version} · {edit.outcomes.length} 项
            </span>
            <Button
              variant="plain"
              type="button"
              onClick={() => setShowEdits((value) => !value)}
              aria-label={showEdits ? '收起改动' : `查看 v${edit.version} 的改动`}
              className="p-0 text-slate-500 hover:text-slate-800"
            >
              {showEdits ? '收起' : '查看'}
            </Button>
            {onUndo && canUndo && edit.previousTripId && (
              <Button
                variant="plain"
                type="button"
                disabled={undoing}
                onClick={() => void onUndo(edit.previousTripId!)}
                aria-label="撤销这次修改，回到上一版"
                className="p-0 text-slate-500 hover:text-slate-800 disabled:opacity-50"
              >
                {undoing ? '撤销中…' : '撤销'}
              </Button>
            )}
          </div>
          {showEdits && (
            <ul className="mt-1.5 space-y-1 rounded-lg border border-slate-200/70 bg-slate-50/50 px-3 py-2 text-xs text-slate-600">
              {edit.outcomes.map((outcome, index) => (
                <li key={`${outcome.kind}-${index}`} className="break-words leading-relaxed">
                  <span aria-hidden="true" className={outcome.applied ? 'text-emerald-600' : 'text-slate-400'}>{outcome.applied ? '✓' : '×'}</span>{' '}
                  {outcome.summary}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
});
