import { useState } from 'react';
import { Modal } from '../Modal';
import { Button } from './Button';
import { Input } from './Field';

export function ConfirmDialog({ title, description, onConfirm, onClose }: { title: string; description: string; onConfirm: () => void; onClose: () => void }) {
  return <Modal title={title} onClose={onClose}>
    <p className="text-sm leading-relaxed text-[var(--color-muted)]">{description}</p>
    <div className="mt-5 flex justify-end gap-2"><Button autoFocus onClick={onClose}>取消</Button><Button variant="danger" onClick={() => { onConfirm(); onClose(); }}>确认删除</Button></div>
  </Modal>;
}

export function PromptDialog({ title, initialValue, maxLength, onConfirm, onClose }: { title: string; initialValue: string; maxLength: number; onConfirm: (value: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(initialValue);
  return <Modal title={title} onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); onConfirm(value); onClose(); }}>
    <label className="flex flex-col gap-2 text-sm">{title}<Input autoFocus value={value} maxLength={maxLength} onChange={(event) => setValue(event.target.value)} /></label>
    <div className="mt-5 flex justify-end gap-2"><Button onClick={onClose}>取消</Button><Button type="submit" variant="primary">保存</Button></div>
  </form></Modal>;
}
