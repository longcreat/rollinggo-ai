import { useRef, useState } from 'react';
import { Value } from '@sinclair/typebox/value';
import { TripSchema, uid, type Trip, type TripVersionChain, type TripOperationRequest, type TripOperationResult } from '@tripweaver/shared';
import { api } from '../../api/client';
import { restoreVersion } from '../../api/detailChat';
import { Modal } from '../Modal';
import { Button } from '../ui/Button';

interface Props {
  currentId: string; chain?: TripVersionChain; loading: boolean; failed: boolean; busy: boolean;
  initialRestore?: string; refresh: () => void; close: () => void;
  begin: () => Promise<Trip>; end: () => void;
  onTrip: (id: string, result?: TripOperationResult) => Promise<void>;
}
export function HistoryPanel({ currentId, chain, loading, failed, busy, initialRestore, refresh, close, begin, end, onTrip }: Props) {
  const [selected, setSelected] = useState(initialRestore);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<TripOperationRequest | null>(null);
  const ordered = [...(chain?.versions ?? [])].sort((a, b) => b.version - a.version);
  const latest = ordered[0];
  const switchTo = async (id: string) => {
    if (pending || busy) return;
    setPending(true); setError('');
    let acquired = false;
    try { await begin(); acquired = true; await onTrip(id); close(); }
    catch (err) { setError(err instanceof Error ? err.message : '版本加载失败'); }
    finally { setPending(false); if (acquired) end(); }
  };
  const restore = async () => {
    if (!selected || !latest || pending) return;
    setPending(true); setError('');
    let acquired = false;
    try {
      const current = await begin(); acquired = true;
      if (!request.current) {
        const saved = currentId === latest.id ? current : await api.get<unknown>(`/api/trips/${latest.id}`);
        if (!Value.Check(TripSchema, saved)) throw new Error('最新版本读取失败');
        request.current = { operationId: uid(), expectedTripId: saved.id, updatedAt: saved.updatedAt };
      }
      const result = await restoreVersion(selected, request.current);
      await onTrip(result.trip.id, result); close();
    } catch (err) { setError(err instanceof Error ? err.message : '恢复失败，请重试'); }
    finally { setPending(false); if (acquired) end(); }
  };
  return <Modal title="历史版本" size="drawer" onClose={() => { if (!pending) close(); }} footer={
    <p className="m-0 flex items-start gap-2 text-[12px] leading-[1.7] text-[var(--color-editor-page-editor-muted-56)]">
      <svg className="mt-1 shrink-0" width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M10 9v5m0-8v1" /></svg>
      记录生成、手动修改、修订和恢复产生的版本
    </p>
  }>
    {loading && <p role="status" className="rounded-2xl bg-white/70 p-4">正在加载版本…</p>}
    {failed && <p role="alert" className="rounded-2xl bg-white/70 p-4">版本加载失败 <Button variant="ghost" onClick={refresh}>重试</Button></p>}
    {!loading && !failed && ordered.length <= 1 && <p className="rounded-2xl bg-white/70 p-4 text-[14px] text-[var(--color-editor-page-editor-muted-56)]">{ordered.length ? '暂无更早版本。修改行程并保存后，可在这里查看。' : '暂无可查看的版本。'}</p>}
    <ol className="history-versions m-0 flex list-none flex-col gap-3 p-0 pb-2 pr-1">{ordered.map((version, index) => <li key={version.id} className="relative pl-6">
      {index < ordered.length - 1 && <span aria-hidden="true" className="absolute bottom-[-36px] left-[4px] top-6 w-px bg-gradient-to-b from-accent-teal/35 to-brand-disabled/40" />}
      <span aria-hidden="true" className={`absolute left-0 top-6 box-border size-[9px] rounded-full ${version.id === currentId ? 'border-2 border-solid border-emerald-400 bg-white' : index === 1 ? 'bg-accent-teal/70' : index === 2 ? 'bg-brand-sky/80' : 'bg-brand-disabled'}`} />
      <article aria-label={`版本 v${version.version}`} aria-current={version.id === currentId ? 'true' : undefined} className="relative box-border flex min-h-[148px] flex-col rounded-[14px] border border-solid border-ink/5 bg-white px-4 py-4 shadow-[0_4px_12px_var(--color-editor-page-box-shadow-71)]">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-[16px] font-semibold text-ink">v{version.version}</strong>
          {version.id === latest?.id && <span className="text-[12px] font-medium text-ink-soft">最新版本</span>}
          {version.id === currentId && <span className="ml-auto rounded-md bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700">正在查看</span>}
        </div>
        <p className="mb-2 mt-3 text-[12px] text-[var(--color-editor-page-editor-muted-56)]"><time dateTime={new Date(version.createdAt).toISOString()}>{new Date(version.createdAt).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</time></p>
        <p className="mb-5 mt-0 break-words text-[14px] font-medium leading-[1.6] text-ink">{version.summary ?? version.title}</p>
        <div className="mt-auto flex flex-wrap justify-end gap-3">
          <Button variant="plain" className="min-h-8 min-w-14 rounded-[10px] border border-solid border-ink/10 bg-white px-3 py-1 text-[13px] text-ink-muted hover:bg-brand/5 disabled:opacity-35 max-[600px]:min-h-11" disabled={busy || pending || version.id === currentId} onClick={() => void switchTo(version.id)}>查看</Button>
          {version.id !== latest?.id && <Button variant="plain" className="min-h-8 min-w-14 rounded-[10px] border border-solid border-brand/20 bg-brand/5 px-3 py-1 text-[13px] text-brand hover:bg-brand/10 disabled:opacity-50 max-[600px]:min-h-11" disabled={busy || pending} onClick={() => { setSelected(version.id); request.current = null; setError(''); }}>恢复</Button>}
        </div>
        {selected === version.id && <div className="mt-4 rounded-xl bg-brand/5 p-3"><p className="mt-0 text-[14px] leading-[1.7]">将 v{version.version} 的内容恢复为最新版本，现有版本会保留。</p><div className="flex flex-wrap gap-2"><Button variant="primary" disabled={busy || pending} onClick={() => void restore()}>{pending ? '正在恢复…' : '恢复为最新版本'}</Button><Button variant="ghost" disabled={pending} onClick={() => { setSelected(undefined); request.current = null; }}>取消</Button></div></div>}
      </article>
    </li>)}</ol>
    {busy && !pending && <p>当前操作结束后可切换或恢复版本。</p>}
    {error && <p role="alert" className="text-[var(--color-danger)]">{error} <Button onClick={() => { request.current = null; refresh(); }}>刷新版本</Button></p>}
  </Modal>;
}
