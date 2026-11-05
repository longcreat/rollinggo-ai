import { Button } from '../ui/Button';
import { EditorIcon } from './EditorIcon';

export function MapControls({ onZoomIn, onZoomOut, onReset }: { onZoomIn: () => void; onZoomOut: () => void; onReset: () => void }) {
  return <div className={"editor-map-controls absolute [right:12px] [bottom:42px] [z-index:1000] [border:1px_solid_white] [border-radius:24px] [background:var(--color-editor-map-controls-background-103)] [box-shadow:0_4px_18px_var(--color-editor-page-box-shadow-72)] flex flex-col [padding:6px] [&_button]:[width:40px] [&_button]:[height:40px] [&_button]:border-0 [&_button]:[background:none] [&_button]:[color:var(--color-editor-map-controls-color-104)] [&_button]:[font-size:24px] [&_button]:cursor-pointer [&_button]:[border-radius:50%] [&_button]:grid [&_button]:[place-items:center] [&_button:last-child]:[border-top:1px_solid_var(--color-editor-map-controls-border-top-105)] [&_button:last-child]:[border-radius:0_0_20px_20px] [&_button:hover]:[background:var(--color-editor-menu-list-background-87)]"} role="group" aria-label="地图视野" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
    <Button variant="plain" type="button" aria-label="放大地图" title="放大" onClick={onZoomIn}>＋</Button>
    <Button variant="plain" type="button" aria-label="缩小地图" title="缩小" onClick={onZoomOut}>−</Button>
    <Button variant="plain" type="button" aria-label="默认视图" title="默认视图" onClick={onReset}><EditorIcon name="reset" /></Button>
  </div>;
}
