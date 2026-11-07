import { dateForDayIndex, type ResearchPoi, type Trip, type TripWeather } from '@tripweaver/shared';
import { buildTripAdvice, type TripAdvice } from '../../lib/tripAdvice';
import { Button } from '../ui/Button';
import { DayWeather } from './DayWeather';
import { EditorIcon } from './EditorIcon';
import { handwritingFallback } from '../../lib/handwriting';

function AdviceList({ title, items, caution = false }: { title: string; items: TripAdvice[]; caution?: boolean }) {
  return <section aria-label={title}>
    <h3 className="mb-2.5 flex items-center gap-2 text-base font-semibold"><span className="text-slate-800"><EditorIcon name={caution ? 'alert' : 'bulb'} /></span>{title}</h3>
    <ul className="m-0 list-none space-y-2 p-0">
      {items.map(item => <li key={item.id} className="relative pl-4 text-sm leading-6 text-[var(--editor-muted)] before:absolute before:left-0 before:top-[10px] before:size-1 before:rounded-full before:bg-slate-700 before:content-['']">
        <span className="block"><span className="font-medium text-[var(--editor-ink)]">{item.title}</span>：{item.text}</span>
        {!!item.sources?.length && <span className="ml-2 inline-flex flex-wrap gap-x-2 text-xs">
          {item.sources.filter(source => /^https?:\/\//.test(source.url)).map((source, index) => <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer" className="text-slate-700 underline underline-offset-2 hover:text-slate-950" aria-label={`${item.title}：${source.title}`}>来源{item.sources!.length > 1 ? index + 1 : ''}</a>)}
        </span>}
      </li>)}
    </ul>
  </section>;
}

export function TripOverview({ trip, weather, loading, onSelectDay, onAddDay, readOnly, busy, pois }: {
  trip: Trip; weather?: TripWeather; loading: boolean;
  onSelectDay: (index: number) => void; onAddDay: () => void; readOnly: boolean; busy: boolean; pois: Map<string, ResearchPoi>;
}) {
  const advice = buildTripAdvice(trip, weather, pois);
  const stops = trip.days.reduce((sum, day) => sum + day.activities.length, 0);
  return <section className="editor-overview pb-2" aria-label="行程总览">
    {advice.stale && <p role="status" className="mb-3 text-sm leading-6 text-[var(--editor-muted)]">专属旅行建议与注意事项待更新；暂显示基础提醒，重新规划后更新。</p>}
    <div className="mb-4 grid border-b border-[var(--color-border)] pb-4 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))] [gap:20px]">
      <AdviceList title="旅行建议" items={advice.suggestions} />
      <AdviceList title="注意事项" items={advice.cautions} caution />
    </div>
    <p className="mb-3 mt-0 flex flex-wrap items-center gap-2 text-xs text-[var(--editor-muted)]"><span>共 {stops} 站</span><span>点击查看当天</span></p>
    {trip.days.length === 0 && <p className="py-5 text-sm text-[var(--editor-muted)]">还没有行程，添加一天开始安排吧。</p>}
    <ol className="m-0 list-none space-y-2.5 p-0">
      {trip.days.map(day => {
        const date = dateForDayIndex(trip.startDate, day.dayIndex);
        return <li key={day.id}>
          <Button variant="plain" className="editor-overview-day group block w-full rounded-2xl border border-slate-200/90 bg-[var(--color-card)] p-4 text-left text-inherit transition-colors hover:border-slate-400 motion-reduce:transition-none" onClick={() => onSelectDay(day.dayIndex)} aria-label={`查看第${day.dayIndex}天：${day.title || '待安排的旅程'}`}>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-[var(--editor-muted)]">
              <span className="flex flex-wrap items-center gap-2">第 {day.dayIndex} 天<span>{date ? date.slice(5).replace('-', '月') + '日' : '日期待定'}</span></span>
              <DayWeather weather={weather} destination={trip.destination} date={date} loading={loading} compact />
            </div>
            <div className="mt-1 flex items-start justify-between gap-3">
              <h4 className="m-0 break-words [font:400_30px/1.3_'Youran_Handwriting',_serif]" style={handwritingFallback(day.title || '待安排的旅程')}>{day.title || '待安排的旅程'}</h4>
              <span aria-hidden="true" className="mt-2 shrink-0 text-slate-400 group-hover:text-slate-800 transition-colors"><EditorIcon name="forward" /></span>
            </div>
            <p className="mb-0 mt-2 flex items-start gap-1.5 text-sm leading-6 text-[var(--editor-muted)]">
              <span aria-hidden="true" className="mt-[3px] shrink-0 text-slate-500"><EditorIcon name="pin" /></span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
                {day.activities.map((activity, index) => <span key={activity.id} className="inline-flex items-center gap-1.5">{index > 0 && <span aria-hidden="true" className="text-slate-400">→</span>}{activity.name}</span>)}
                {day.activities.length === 0 && <span>这一天还没有安排</span>}
              </span>
            </p>
          </Button>
        </li>;
      })}
    </ol>
    {!readOnly && <Button disabled={busy} variant="secondary" className="btn-add-day mt-3 w-full justify-center" onClick={onAddDay}>＋ 添加一天</Button>}
  </section>;
}
