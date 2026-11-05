import { Button, buttonClassName } from './ui/Button';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Trip } from '@tripweaver/shared';
import { PrintView } from './PrintView';
import { ExportDialog } from './ExportDialog';
import { Dropdown } from './ui/Dropdown';
import { ShareIcon } from './ShareIcon';
import { printTrip } from '../lib/export';

export function ExportMenu({ trip }: { trip: Trip }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDetailsElement>(null);

  return (
    <>
      <Dropdown label="分享行程" menuRef={menuRef}
        summaryClassName={`${buttonClassName('secondary')} box-border [@media_(max-width:_600px)]:h-11 [@media_(max-width:_600px)]:w-11 [@media_(max-width:_600px)]:p-0`}
        panelClassName="min-w-36! rounded-xl! border-white/80! bg-white/95! p-1.5! text-[var(--color-text)] shadow-[0_8px_30px_var(--color-editor-menu-list-box-shadow-86)]! backdrop-blur-xl"
        trigger={<><ShareIcon name="share" /><span className="[@media_(max-width:_600px)]:hidden">分享行程</span></>}>
        <Button variant="plain" className="flex min-h-11 items-center gap-2.5 rounded-lg border-0 bg-transparent px-3 text-left text-sm text-[var(--color-text)] hover:bg-brand/5" onClick={printTrip}><ShareIcon name="pdf" />导出 PDF</Button>
        <Button variant="plain" className="flex min-h-11 items-center gap-2.5 rounded-lg border-0 bg-transparent px-3 text-left text-sm text-[var(--color-text)] hover:bg-brand/5" onClick={() => {
          // 菜单关闭前将焦点交回常驻入口，Modal 关闭后才能可靠恢复焦点。
          menuRef.current?.querySelector('summary')?.focus();
          setOpen(true);
        }}><ShareIcon name="image" />AI 生成海报</Button>
      </Dropdown>

      {/* 常驻离屏：@media print 显示 */}
      {createPortal(<div className={"print-host fixed [left:-10000px] [top:0] [width:720px] [background:var(--color-btn-primary-color-3)] pointer-events-none [z-index:-1] [@media_print]:visible [@media_print]:[&_*]:visible [@media_print]:absolute! [@media_print]:[left:0]! [@media_print]:[top:0]! [@media_print]:w-full! [@media_print]:[z-index:9999]"} aria-hidden="true">
        <PrintView trip={trip} />
      </div>, document.body)}

      <ExportDialog key={trip.id} trip={trip} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
