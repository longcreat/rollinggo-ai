import { Button } from '../ui/Button';
import { useEffect, useRef, useState } from 'react';
import { LEG_MODES, type LegMode, type RouteOptionsRequest, type TransitLeg } from '@tripweaver/shared';
import { useRouteOptions } from '../../api/routeOptions';
import { routePairKey } from '../../lib/routePair';
import { hasValidCoord } from '../../lib/colors';
import { formatLegDistance, formatLegDuration, LEG_MODE_LABEL } from '../../lib/tripDerive';
import { useEditorStore } from '../../store/editorStore';
import { EditorIcon } from './EditorIcon';
import { useDismissibleDisclosure } from '../ui/Dropdown';

export function RouteOptions({ dayId, fromId, leg }: { dayId: string; fromId: string; leg?: TransitLeg }) {
  const readOnly = useEditorStore((s) => s.readOnly);
  const trip = useEditorStore((s) => s.trip);
  if (readOnly) return leg ? <p className="flex flex-wrap items-center gap-2 px-3 text-[14px] text-ink-muted">{LEG_MODE_LABEL[leg.mode]}<span>{formatLegDuration(leg.durationMin)}{leg.source === 'heuristic' ? '（估算）' : ''}</span></p> : null;
  const key = trip ? routePairKey(trip, dayId, fromId) : null;
  if (!trip || !key) return null;
  const day = trip.days.find((d) => d.id === dayId)!;
  const index = day.activities.findIndex((a) => a.id === fromId);
  const input = { from: day.activities[index]!, to: day.activities[index + 1]!, destination: trip.destination };
  return <RouteOptionsForPair key={key} pairKey={key} tripId={trip.id} input={input} dayId={dayId} leg={leg} />;
}

function RouteOptionsForPair({ pairKey, tripId, input, dayId, leg }: {
  pairKey: string; tripId: string; input: RouteOptionsRequest; dayId: string; leg?: TransitLeg;
}) {
  const valid = hasValidCoord(input.from) && hasValidCoord(input.to);
  const replan = useEditorStore((s) => s.routeReplans[pairKey]);
  const { queries, get } = useRouteOptions(pairKey, tripId, input, valid);
  const [pendingMode, setPendingMode] = useState<LegMode>();
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const active = useRef(true);
  const selection = useRef(0);
  const details = useRef<HTMLDetailsElement>(null);
  const disclosureEvents = useDismissibleDisclosure(details);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; selection.current++; };
  }, []);

  async function select(mode: LegMode) {
    useEditorStore.getState().cancelRouteReplan(pairKey);
    const version = ++selection.current;
    setPendingMode(mode);
    setError('');
    try {
      const option = await get(mode);
      if (!active.current || selection.current !== version) return;
      if (option.status !== 'available') { setError(option.reason); return; }
      if (!useEditorStore.getState().selectRoute(dayId, pairKey, option.leg)) { setError('路段已变化，请重新选择'); return; }
      if (details.current) { details.current.open = false; details.current.querySelector('summary')?.focus(); }
    } catch (e) {
      if (active.current && selection.current === version) setError(e instanceof Error ? e.message : '路线查询失败，请重试');
    } finally {
      if (active.current && selection.current === version) setPendingMode(undefined);
    }
  }

  async function retry() {
    setRefreshing(true);
    setError('');
    const results = await Promise.allSettled(LEG_MODES.map((mode) => get(mode, true)));
    if (!active.current) return;
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') setError(failure.reason instanceof Error ? failure.reason.message : '路线查询失败，请重试');
    setRefreshing(false);
  }

  const backgroundError = queries.find((q) => q.error)?.error?.message;
  return <div className="activity-between py-2 text-[13px] text-[var(--editor-muted)]">
    <details ref={details} className="group rounded-[14px]" {...disclosureEvents}>
      <summary className="editor-transit flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full border-0 bg-transparent px-3 text-[var(--color-editor-menu-color-83)] transition-colors hover:bg-[var(--color-editor-menu-list-background-87)] group-open:bg-[var(--color-editor-menu-list-background-87)] [&::-webkit-details-marker]:hidden" aria-label="切换交通方式">
        <EditorIcon name={leg?.mode === 'transit' ? 'route' : leg?.mode ?? 'route'} />
        <span className="flex flex-1 flex-wrap items-center gap-2" role="status">{pendingMode ? '正在规划' + LEG_MODE_LABEL[pendingMode] + '路线…' : replan?.status === 'pending' ? '正在选择推荐交通方式…' : leg ? <><span>{LEG_MODE_LABEL[leg.mode] + '约' + formatLegDuration(leg.durationMin)}</span><span>{leg.source === 'heuristic' ? '估算' : formatLegDistance(leg.distanceM)}</span></> : '选择交通方式'}</span>
        <svg className="transition-transform group-open:rotate-180" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </summary>
      <div className="mt-2 rounded-[14px] border border-[var(--color-editor-menu-list-border-85)] bg-[var(--color-card)] p-1.5 shadow-[0_10px_30px_var(--color-editor-menu-list-box-shadow-86)]" aria-label="交通方式选项">
        <p className="px-3 pb-1 pt-2 text-[11px] text-[var(--editor-muted)]">选择后自动规划推荐路线</p>
        {!valid && <p role="status" className="px-3 py-2">地点缺少坐标，暂时无法规划路线</p>}
        {(error || backgroundError) && <p role="alert" className="px-3 py-2 text-[var(--color-danger)]">{error || backgroundError}</p>}
        {LEG_MODES.map((mode, index) => {
          const query = queries[index]!;
          const option = query.data;
          const selected = leg?.mode === mode;
          const pending = pendingMode === mode;
          return <Button variant="plain" key={mode} type="button" disabled={!valid || option?.status === 'unavailable'}
            aria-pressed={selected} aria-busy={pending}
            className={['flex min-h-12 w-full items-center gap-3 rounded-[10px] border-0 px-3 py-2 text-left text-[13px] shadow-none transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              selected ? '[background:var(--editor-gradient)] text-white' : 'bg-transparent text-[var(--color-editor-menu-color-83)] hover:bg-[var(--color-editor-menu-list-background-87)]'].join(' ')}
            onClick={() => void select(mode)}>
            <EditorIcon name={mode === 'transit' ? 'route' : mode} />
            <span className="shrink-0">{LEG_MODE_LABEL[mode]}</span>
            <span className="ml-auto flex items-center gap-2 text-right text-xs">{pending ? '正在规划…' : option?.status === 'available' ? <><span>{formatLegDuration(option.leg.durationMin)}</span><span>{formatLegDistance(option.leg.distanceM)}</span></> : option?.status === 'unavailable' ? option.reason : query.isFetching ? '查询中…' : '选择后规划'}</span>
            {selected && <span aria-hidden="true">✓</span>}
          </Button>;
        })}
        {leg && leg.source !== 'heuristic' && !leg.polyline && <p className="px-3 py-2 text-xs">此路线暂无路径图，地图显示地点连线。</p>}
        {(error || backgroundError || refreshing) && <div className="mt-1 flex justify-end border-t border-[var(--color-editor-menu-list-border-top-89)] pt-1">
          <Button variant="ghost" type="button" className="text-xs" disabled={!valid || queries.some((q) => q.isFetching)} loading={refreshing} onClick={() => void retry()}>
            <span aria-live="polite">{refreshing ? '查询中…' : '重试'}</span>
          </Button>
        </div>}
      </div>
    </details>
    {replan?.status === 'error' && <div role="alert" className="flex items-center gap-2 px-3 text-xs text-[var(--color-danger)]">
      <span>{replan.error}</span>
      <Button variant="plain" type="button" className="min-h-10 shrink-0 rounded-full border-0 bg-transparent px-3 text-[var(--editor-muted)] shadow-none hover:bg-[var(--color-editor-menu-list-background-87)]" onClick={() => useEditorStore.getState().retryRouteReplan(pairKey)}>重试推荐</Button>
    </div>}
  </div>;
}
