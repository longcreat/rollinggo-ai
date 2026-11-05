import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

export function useDismissibleDisclosure(ref: RefObject<HTMLDetailsElement | null>) {
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) ref.current.open = false;
    };
    // 异步操作将按钮禁用时焦点可能落回 body，Escape 仍应能收起已打开的面板。
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !ref.current?.open || document.querySelector('dialog[open]')) return;
      ref.current.open = false;
      ref.current.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [ref]);
  return {
    onBlur: (event: React.FocusEvent<HTMLDetailsElement>) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; },
    onKeyDown: (event: React.KeyboardEvent<HTMLDetailsElement>) => {
      if (event.key === 'Escape' && ref.current) { event.stopPropagation(); ref.current.open = false; ref.current.querySelector('summary')?.focus(); }
    },
  };
}

export const dropdownPanelClass = 'absolute right-0 top-full z-40 mt-1 flex min-w-44 flex-col gap-1 rounded-2xl border border-solid border-[var(--color-border)] bg-[var(--color-card)] p-1.5 shadow-xl';

export function Dropdown({ label, trigger, children, className = '', summaryClassName = '', panelClassName = '', menuRef }: { label: string; trigger: ReactNode; children: ReactNode; className?: string; summaryClassName?: string; panelClassName?: string; menuRef?: RefObject<HTMLDetailsElement | null> }) {
  const ownRef = useRef<HTMLDetailsElement>(null);
  const ref = menuRef ?? ownRef;
  const events = useDismissibleDisclosure(ref);
  return <details ref={ref} className={`relative ${className}`} {...events}>
    <summary aria-label={label} className={`list-none cursor-pointer focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden ${summaryClassName}`}>{trigger}</summary>
    <div className={`${dropdownPanelClass} ${panelClassName}`} onClick={(event) => { if ((event.target as HTMLElement).closest('button:not(:disabled)') && ref.current) ref.current.open = false; }}>{children}</div>
  </details>;
}
