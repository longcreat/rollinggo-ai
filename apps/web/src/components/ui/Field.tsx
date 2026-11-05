import type { ComponentProps } from 'react';

const fieldClass = 'ui-field box-border min-h-11 min-w-0 rounded-xl border border-solid border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-base text-[var(--color-text)] transition-colors focus:outline-2 focus:outline-offset-0 focus:outline-brand disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-[var(--color-danger)]';

export function Input({ className = '', type = 'text', ...props }: ComponentProps<'input'>) {
  const compact = ['checkbox', 'radio', 'hidden', 'file', 'range'].includes(type);
  return <input {...props} type={type} className={`${compact ? 'accent-brand focus-visible:outline-brand disabled:opacity-50' : fieldClass} ${className}`} />;
}

export function Select({ className = '', ...props }: ComponentProps<'select'>) {
  return <select {...props} className={`${fieldClass} ui-select cursor-pointer pr-10 ${className}`} />;
}

export function Textarea({ className = '', appearance = 'default', ...props }: ComponentProps<'textarea'> & { appearance?: 'default' | 'embedded' | 'panel' }) {
  const embedded = 'ui-field box-border min-h-11 min-w-0 border-0 bg-transparent px-3 py-2 text-base text-[var(--color-text)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50';
  // 首页玻璃面板内的输入框：token 与面板控件一致，尺寸按 --ui 缩放（不低于基础尺寸）；面板外无 --ui，以 1px 兜底。
  const panel = 'ui-field box-border min-h-[calc(44*max(1px,var(--ui,1px)))] min-w-0 rounded-[calc(12*max(1px,var(--ui,1px)))] border border-solid border-hairline-strong bg-white/60 px-[calc(12*max(1px,var(--ui,1px)))] py-[calc(8*max(1px,var(--ui,1px)))] text-[length:calc(16*max(1px,var(--ui,1px)))] text-ink-strong transition-colors focus:border-brand focus:bg-brand/10 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50';
  const shared = appearance === 'embedded' ? embedded : appearance === 'panel' ? panel : `${fieldClass} resize-y`;
  return <textarea {...props} className={`${shared} ${className}`} />;
}
