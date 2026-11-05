import type { ComponentProps, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'plain';
const variants: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-brand bg-gradient-to-br from-brand-light to-brand text-white hover:from-brand hover:to-brand-deep',
  secondary: 'border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-text)] hover:border-brand hover:text-brand',
  ghost: 'border-transparent bg-transparent text-[var(--color-text)] hover:bg-[var(--color-hairline)]',
  danger: 'border-transparent bg-transparent text-[var(--color-danger)] hover:bg-[var(--color-hairline)]',
  plain: '',
};

export function buttonClassName(variant: ButtonVariant = 'secondary', size: 'default' | 'icon' = 'default') {
  const interaction = 'ui-button cursor-pointer motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed';
  if (variant === 'plain') return interaction;
  return `${interaction} inline-flex items-center justify-center gap-2 rounded-xl border border-solid text-sm font-medium transition-colors disabled:opacity-50 min-h-11 ${size === 'icon' ? 'min-w-11 p-2' : 'px-4 py-2'} ${variants[variant]}`;
}

export function Spinner() {
  return <svg className="shrink-0 animate-spin motion-reduce:animate-none" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle className="opacity-25" cx="12" cy="12" r="9" /><path strokeLinecap="round" d="M12 3a9 9 0 0 1 9 9" /></svg>;
}

export function Button({ variant = 'secondary', size = 'default', loading = false, loadingText, className = '', disabled, children, type = 'button', ...props }: ComponentProps<'button'> & { variant?: ButtonVariant; size?: 'default' | 'icon'; loading?: boolean; loadingText?: ReactNode }) {
  return <button {...props} type={type} className={`${buttonClassName(variant, size)} ${className}`} disabled={disabled || loading} aria-busy={loading || props['aria-busy']}>
    {loading && <Spinner />}{loading && loadingText ? loadingText : children}
  </button>;
}

export function IconButton(props: Omit<ComponentProps<typeof Button>, 'size'> & { 'aria-label': string }) {
  return <Button variant="ghost" {...props} size="icon" />;
}
