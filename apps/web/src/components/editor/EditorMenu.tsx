import type { ReactNode } from 'react';
import { Dropdown } from '../ui/Dropdown';

export function EditorMenu({ label, children }: { label: string; children: ReactNode }) {
  return <Dropdown label={label} className="editor-menu flex-none"
    summaryClassName="grid h-11 w-11 place-items-center rounded-full text-[var(--color-editor-menu-color-83)] hover:bg-[var(--color-hairline)]"
    panelClassName="editor-menu-list w-48 [&_button]:min-h-11 [&_button]:justify-start [&_button]:text-left [&_label]:grid [&_label]:gap-2 [&_label]:p-2 [&_label]:text-sm [&_select]:w-full"
    trigger={<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>}>
    {children}
  </Dropdown>;
}
