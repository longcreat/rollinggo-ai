// turn 末尾唯一的复制按钮；多段正文时由 turn 统一渲染一次。
// 优先 Clipboard API；权限/安全上下文不允许时退回 textarea + execCommand，避免“点了没内容”。
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '../ui/Button';

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 非安全上下文或权限被拒绝时继续走兜底。
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    area.style.top = '0';
    document.body.appendChild(area);
    area.focus();
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

export function CopyButton({ text, className = 'px-1' }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`flex items-center text-slate-400 ${className}`}>
      <Button
        variant="plain"
        type="button"
        onClick={() => {
          void writeClipboard(text).then((ok) => {
            if (!ok) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
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
