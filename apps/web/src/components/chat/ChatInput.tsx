import { Button } from '../ui/Button';
import { SendIcon } from '../home/HomeIcons';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

interface Props {
  disabled: boolean;
  sending: boolean;
  onSend: (text: string) => void;
  onStop?: () => void;
  stopping?: boolean;
  restoreDraft?: { text: string; key: number };
}

export function ChatInput({ disabled, sending, onSend, onStop, stopping, restoreDraft }: Props) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (restoreDraft) setText(restoreDraft.text); }, [restoreDraft]);

  const canSend = !disabled && !sending && text.trim().length > 0;

  const submit = () => {
    const value = text.trim();
    if (!value || !canSend) return;
    onSend(value);
    setText('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  return (
    <div className="chat-input flex h-10 shrink-0 items-center gap-2 rounded-full border border-slate-200/90 bg-white pl-4 pr-1.5 shadow-xs focus-within:border-slate-400 focus-within:ring-2 focus-within:ring-slate-100 transition-all">
      <input
        ref={input}
        type="text"
        className="w-0 flex-1 border-0 border-none outline-none ring-0 shadow-none bg-transparent py-1 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-0 focus:border-none"
        value={text}
        maxLength={1000}
        disabled={disabled}
        placeholder="让 RollingGo 帮你微调行程…"
        aria-label="输入你的行程想法"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <Button
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-0 bg-slate-900 text-white shadow-xs hover:bg-slate-800 disabled:opacity-40 p-0 transition-colors cursor-pointer"
        variant="plain"
        type="button"
        disabled={sending ? stopping : !canSend}
        onClick={sending ? onStop : submit}
        aria-label={sending ? '停止回答' : '发送'}
      >
        {sending ? (
          <span className="text-[10px] font-medium">{stopping ? '停' : '■'}</span>
        ) : (
          <SendIcon className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}
