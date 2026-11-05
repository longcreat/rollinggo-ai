import { useRef, useState } from 'react';
import { foodAlreadyAdded, recommendedFoodPosition, MEAL_LABELS, uid, type FoodCandidate, type Trip, type TripOperationResult, type MealPosition, type AddFoodRequest } from '@tripweaver/shared';
import { addFood } from '../../api/detailChat';
import { Button } from '../ui/Button';
import { FoodPositionChoices } from './FoodPositionChoices';
import { useEditorStore } from '../../store/editorStore';
import { EditorIcon } from '../editor/EditorIcon';

interface Props {
  candidate: FoodCandidate; trip: Trip; conversationId: string; disabled: boolean; readOnly: boolean;
  begin: () => Promise<Trip>; end: () => void; onTrip: (id: string, result?: TripOperationResult) => Promise<void>;
}
export function FoodCard({ candidate, trip, conversationId, disabled, readOnly, begin, end, onTrip }: Props) {
  const recommendation = recommendedFoodPosition(trip, candidate);
  const [position, setPosition] = useState<MealPosition>(recommendation ?? { dayId: candidate.dayId, meal: candidate.meal ?? 'lunch' });
  const [adjusting, setAdjusting] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AddFoodRequest | null>(null);
  const inFlight = useRef(false);
  const existingDay = trip.days.find((d) => d.id === position.dayId && foodAlreadyAdded(d, candidate));
  const existing = existingDay && foodAlreadyAdded(existingDay, candidate);
  const showActivity = () => {
    if (!existingDay || !existing) return;
    useEditorStore.getState().setDayFilter(existingDay.dayIndex);
    requestAnimationFrame(() => document.getElementById(`activity-${existing.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  };
  const submit = async (selected: MealPosition) => {
    if (inFlight.current || disabled) return;
    inFlight.current = true; setPending(true); setError(''); setPosition(selected);
    let acquired = false;
    try {
      const saved = await begin();
      acquired = true;
      // 保留失败请求的完整标识和目标；断线后重试先由后端检查原操作。
      request.current ??= { operationId: uid(), expectedTripId: saved.id, updatedAt: saved.updatedAt, candidateId: candidate.id, position: selected };
      const result = await addFood(conversationId, request.current);
      await onTrip(result.trip.id, result); setAdjusting(false); request.current = null;
    } catch (err) { setError(err instanceof Error ? err.message : '添加失败，请重试'); }
    finally { inFlight.current = false; setPending(false); if (acquired) end(); }
  };
  const anchor = recommendation?.beforeActivityId ? trip.days.find((d) => d.id === recommendation.dayId)?.activities.find((a) => a.id === recommendation.beforeActivityId)?.name : undefined;
  const sources = candidate.sources.filter((source, index, all) => all.findIndex((entry) => entry.url === source.url && entry.title === source.title) === index);
  // 旧候选可能携带地点供应商的数字分类码，不能作为可读菜系展示。
  const cuisine = candidate.cuisine && /\p{L}/u.test(candidate.cuisine) ? candidate.cuisine : undefined;
  return <article className="food-card my-2 min-w-0 rounded-2xl border border-slate-200/80 bg-slate-50/70 p-3.5 text-xs sm:text-sm leading-relaxed shadow-2xs" aria-label={candidate.name}>
    <div className="flex items-start gap-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-orange-100/70 text-orange-600" aria-hidden="true">
        <EditorIcon name="food" className="w-4 h-4" />
      </span>
      <div className="min-w-0">
        <strong className="break-words font-semibold text-slate-800 text-sm">{candidate.name}</strong>
        <p className="mb-0 mt-0.5 text-xs text-slate-500">第 {candidate.dayIndex} 天{candidate.nearby ? ` · ${candidate.nearby}附近` : ''}</p>
      </div>
    </div>
    <p className="mb-2 mt-2 break-words text-slate-600 text-xs sm:text-sm">{candidate.reason}</p>
    {candidate.address && <p className="my-1.5 break-words text-xs text-slate-500">{candidate.address}</p>}
    {cuisine && <p className="my-1.5 text-xs text-slate-500">{cuisine}</p>}
    {candidate.openTime && <p className="my-1.5 text-xs text-slate-500">营业信息：{candidate.openTime}</p>}
    <details className="text-xs text-slate-400 mt-1">
      <summary className="cursor-pointer py-1 font-medium">参考来源 · {sources.length}</summary>
      <div className="flex flex-col gap-1 pb-1">
        {sources.map((source, i) => /^https?:\/\//.test(source.url) ? <a className="inline-flex items-center text-slate-700 underline underline-offset-2 hover:text-slate-950" key={i} href={source.url} target="_blank" rel="noreferrer">{source.title}{sources.length > 1 ? ` ${i + 1}` : ''} ↗</a> : <span key={i}>{source.title}</span>)}
      </div>
    </details>
    {anchor && <p className="my-1.5 text-xs text-slate-600 font-medium">{anchor}之前 · 推荐位置</p>}
    {existing ? <Button variant="ghost" className="min-h-8 rounded-full text-xs text-slate-800 font-medium" onClick={showActivity}>已加入第 {existingDay?.dayIndex} 天 · 查看新增活动</Button> : readOnly ? <p className="text-xs text-slate-400">返回最新版本后可添加</p> : <div className="mt-2 flex flex-wrap gap-2">
      <Button variant={recommendation ? 'primary' : 'secondary'} className="min-h-8 rounded-full text-xs px-3 py-1" disabled={disabled || pending} onClick={() => recommendation && !error ? void submit(recommendation) : error && request.current ? void submit(request.current.position) : setAdjusting(true)}>{pending ? '正在添加…' : error && request.current ? '重试添加' : recommendation ? `加入第 ${trip.days.find((d) => d.id === recommendation.dayId)?.dayIndex} 天 · ${MEAL_LABELS[recommendation.meal]}` : '选择添加位置'}</Button>
      {recommendation && <Button variant="ghost" className="min-h-8 rounded-full text-xs text-slate-700 hover:text-slate-950" disabled={disabled || pending} onClick={() => setAdjusting(true)}>调整位置</Button>}
    </div>}
    {adjusting && !existing && !readOnly && <FoodPositionChoices trip={trip} candidate={candidate} initial={position} disabled={disabled || pending} onCancel={() => setAdjusting(false)} onSelect={(selected) => { request.current = null; setError(''); void submit(selected); }} />}
    {error && <p className="mb-0 text-red-500 text-xs" role="alert">{error}</p>}
  </article>;
}
