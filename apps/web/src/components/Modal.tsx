import { IconButton } from './ui/Button';
import { useEffect, useId, useRef, type ReactNode } from 'react';

// 原生 <dialog> 封装：免费拿到遮罩、焦点陷阱与 ESC 关闭
export function Modal({ title, onClose, children, footer, size = 'default', closeOnBackdrop = true }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'default' | 'photo' | 'drawer' | 'sheet' | 'auth' | 'screen' | 'poster'; closeOnBackdrop?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const poster = size === 'poster';

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previousFocus = document.activeElement;
    if (!dialog.open) dialog.showModal();
    const handleCancel = (e: Event) => {
      e.preventDefault();
      closeRef.current();
    };
    dialog.addEventListener('cancel', handleCancel);
    return () => {
      dialog.removeEventListener('cancel', handleCancel);
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        const disclosure = previousFocus.closest('details');
        const target = disclosure && !disclosure.open ? disclosure.querySelector('summary') : previousFocus;
        target?.focus();
      }
    };
  }, []);

  return (
    <dialog ref={ref} aria-labelledby={titleId} className={`modal box-border ${poster ? 'h-[640px] max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] max-w-[480px] overflow-hidden rounded-[14px] border-0 bg-white text-[var(--color-text)] backdrop:bg-ink/35 backdrop:backdrop-blur-[4px]' : size === 'screen' ? "fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-hidden rounded-none border-0 text-ink [background:var(--color-canvas)_url('/home-bg.webp')_center_/_cover_no-repeat] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]" : size === 'sheet' ? 'fixed inset-x-0 bottom-0 top-auto m-0 max-h-[85dvh] w-full max-w-none overflow-y-auto rounded-t-3xl rounded-b-none border-white bg-white text-ink pb-[env(safe-area-inset-bottom)] backdrop:bg-ink/25' : size === 'drawer' ? 'fixed bottom-5 left-auto right-[clamp(16px,1.9vw,32px)] top-[clamp(56px,4.2vw,72px)] m-0 h-[calc(100dvh-clamp(56px,4.2vw,72px)-20px)] max-h-none w-[clamp(280px,20vw,340px)] max-w-[calc(100vw-32px)] overflow-hidden rounded-[18px] border-white bg-white/95 text-[var(--color-editor-page-editor-ink-55)] backdrop-blur-xl backdrop:bg-ink/30 backdrop:backdrop-blur-[2px] max-[600px]:inset-0 max-[600px]:h-dvh max-[600px]:w-full max-[600px]:max-w-none max-[600px]:rounded-none' : `max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] overflow-y-auto rounded-2xl border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-text)] backdrop:bg-[rgba(19,32,40,0.45)] ${size === 'photo' ? 'max-w-[1100px]' : size === 'auth' ? 'max-w-[360px]' : 'max-w-[480px]'}`} ${size === 'screen' || poster ? '' : 'border'} border-solid p-0 shadow-xl`} onClick={(e) => {
      if (!closeOnBackdrop) return;
      if (e.target !== ref.current) return;
      const rect = e.currentTarget.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) onClose();
    }}>
      <div className={poster ? 'modal-body box-border flex h-full min-h-0 flex-col p-5' : size === 'drawer' || size === 'screen' ? 'modal-body box-border flex h-full min-h-0 flex-col p-5' : 'modal-body p-5'}>
        <div className={`modal-head flex shrink-0 items-center justify-between ${poster ? 'mb-3 h-10' : size === 'drawer' ? 'mb-5' : 'mb-3.5'}`}>
          {size === 'screen' && <IconButton variant="plain" className="grid h-11 w-11 place-items-center rounded-full text-ink" onClick={onClose} aria-label="返回首页"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m15 5-7 7 7 7" /></svg></IconButton>}
          <h2 id={titleId} className={poster ? 'm-0 text-base font-semibold' : size === 'screen' ? 'm-0 flex-1 pr-11 text-center text-lg' : 'm-0 text-lg'}>{title}</h2>
          {size !== 'screen' && <IconButton onClick={onClose} aria-label="关闭" className={poster ? '-mr-2.5' : ''}>
            {poster ? <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="m6 6 12 12M6 18 18 6" /></svg> : '✕'}
          </IconButton>}
        </div>
        {poster || size === 'drawer' || size === 'screen' ? <div className="modal-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:thin]">{children}</div> : children}
        {footer && <div className={poster ? 'modal-footer mt-7 shrink-0' : 'modal-footer mt-4 shrink-0 border-0 border-t border-solid border-ink/5 pt-4'}>{footer}</div>}
      </div>
    </dialog>
  );
}
