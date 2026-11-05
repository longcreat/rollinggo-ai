import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Value } from '@sinclair/typebox/value';
import { TripSchema, type Trip, type TripVersionChain } from '@tripweaver/shared';
import { keys, useSaveTrip } from '../api/hooks';
import { useEditorStore } from '../store/editorStore';

/** 串行保存最新草稿；flush 在切版本/写操作前等待所有已编辑 revision。 */
export function useEditorSave(id: string, readOnly: boolean, onSaved: (trip: Trip) => void) {
  const qc = useQueryClient();
  const mutation = useSaveTrip();
  const mutate = useRef(mutation.mutateAsync);
  mutate.current = mutation.mutateAsync;
  const notify = useRef(onSaved);
  notify.current = onSaved;
  const revision = useEditorStore((s) => s.revision);
  const routesPending = useEditorStore((s) => Object.values(s.routeReplans).some((job) => job.status === 'pending'));
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const owner = useRef({ routeId: id, tripId: id, saved: 0, running: null as Promise<void> | null, retry: null as Trip | null });
  if (owner.current.routeId !== id) {
    if (owner.current.tripId === id) owner.current.routeId = id;
    else owner.current = { routeId: id, tripId: id, saved: 0, running: null, retry: null };
  }
  const flush = useCallback(async () => {
    const session = owner.current;
    while (session.running) await session.running;
    if (!mounted.current || session !== owner.current) throw new Error('当前行程已切换');
    if (session.saved >= useEditorStore.getState().revision || readOnly) return;
    const save = async () => {
      setState('saving'); setError('');
      try {
        while (mounted.current && session === owner.current) {
          const current = useEditorStore.getState();
          if (!current.trip || current.trip.id !== session.tripId || session.saved >= current.revision) break;
          if (Object.values(current.routeReplans).some((job) => job.status === 'pending')) break;
          const savingRevision = current.revision;
          const snapshot = session.retry ?? current.trip;
          const retriedOlderDraft = snapshot !== current.trip;
          session.retry = snapshot;
          const result = await mutate.current(snapshot);
          if (!Value.Check(TripSchema, result)) throw new Error('保存结果无效，请重试');
          if (!mounted.current || session !== owner.current) return;
          const previousId = session.tripId;
          session.tripId = result.id;
          session.retry = null;
          useEditorStore.getState().acknowledgeSave(previousId, result);
          // 失败期间也可能继续编辑；重试成功后仍需把当前草稿完整保存。
          if (!retriedOlderDraft) session.saved = savingRevision;
          if (result.id !== previousId) {
            const chain = qc.getQueryData<TripVersionChain>(keys.tripVersions(previousId));
            if (chain) qc.setQueryData(keys.tripVersions(result.id), { ...chain, versions: [...chain.versions, {
              id: result.id, version: Math.max(0, ...chain.versions.map((v) => v.version)) + 1,
              title: result.title, createdAt: result.createdAt, summary: '手动修改行程',
            }] });
            const conversation = qc.getQueryData<{ conversationId: string | null }>(['trips', previousId, 'conversation']);
            if (conversation) {
              qc.setQueryData(['trips', result.id, 'conversation'], conversation);
              if (conversation.conversationId) void qc.invalidateQueries({ queryKey: keys.conversation(conversation.conversationId) });
            }
            notify.current(result);
          }
          void qc.invalidateQueries({ queryKey: keys.trips });
        }
        if (mounted.current && session === owner.current) setState('saved');
      } catch (err) {
        if (mounted.current && session === owner.current) { setState('error'); setError(err instanceof Error ? err.message : '保存失败'); }
        throw err;
      }
    };
    session.running = save();
    try { await session.running; } finally { session.running = null; }
  }, [qc, readOnly]);
  useEffect(() => { setState('idle'); setError(''); }, [id]);
  useEffect(() => {
    if (readOnly || routesPending || revision <= owner.current.saved) return;
    setState('saving');
    const timer = setTimeout(() => { void flush().catch(() => {}); }, 800);
    return () => clearTimeout(timer);
  }, [revision, routesPending, readOnly, flush]);
  return { state, error, flush };
}
