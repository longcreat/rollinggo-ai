// turn 末尾唯一的复制按钮；多段正文时由 turn 统一渲染一次。
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '../ui/Button';

export function CopyButton({ text, className = 'px-1' }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`flex items-center text-slate-400 ${className}`}>
      <Button
        variant="plain"
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        aria-label={copied ? '已复制' : '复制回答'}
        title={copied ? '已复制' : '复制回答'}
        className="p-0 hover:text-slate-700"
      >
        {copied
          ? <Check className="h-3.5 w-3.5" aria-hidden="true" />
          : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
      </Button>
    </div>
  );
}
