import { dateForDayIndex, type ResearchPoi, type Trip, type TripWeather } from '@tripweaver/shared';
import { buildTripAdvice, type TripAdvice } from '../../lib/tripAdvice';
import { Button } from '../ui/Button';
import { DayWeather } from './DayWeather';
import { EditorIcon } from './EditorIcon';

/** 极简净化地名：剥离冗长的风景区/公园前缀、广告副标及重复分店，避免卡片信息拥挤 */
export function simplifyPlaceName(name: string): string {
  let s = name.trim();
  s = s.replace(/^[^\-—–]+(风景名胜区|风景区|旅游区|度假区|景区|国家公园|名胜区|公园)[\-—–]/, '');
  s = s.replace(/^[^\-—–]+(风景区|名胜区)[\-—–]/, '');
  s = s.replace(/^(午餐|晚餐|早餐|下午茶|夜宵)\s*\|\s*/, '$1 · ');
  s = s.replace(/·(传承|正宗|地道|特色|老字号)[^()（）]+/g, '');
  s = s.replace(/[\(（][^)）]+[\)）]$/, '');
  return s.trim();
}

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
          <Button variant="plain" className="editor-overview-day group block w-full rounded-xl border border-slate-200/80 bg-[var(--color-card)] p-4 text-left text-inherit transition-all hover:border-slate-300 hover:shadow-sm motion-reduce:transition-none" onClick={() => onSelectDay(day.dayIndex)} aria-label={`查看第${day.dayIndex}天：${day.title || '待安排的旅程'}`}>
            <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
              <span className="flex items-center gap-1.5 font-medium text-slate-700">
                第 {day.dayIndex} 天
                <span className="text-slate-300 font-normal">·</span>
                <span className="font-normal text-slate-500">{date ? date.slice(5).replace('-', '月') + '日' : '日期待定'}</span>
              </span>
              <DayWeather weather={weather} destination={trip.destination} date={date} loading={loading} compact />
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-3">
              <h4 className="m-0 text-base font-semibold tracking-tight text-slate-900 group-hover:text-black transition-colors">{day.title || '待安排的旅程'}</h4>
              <span aria-hidden="true" className="shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-slate-600"><EditorIcon name="forward" /></span>
            </div>
            <p className="mb-0 mt-2 flex items-start gap-1.5 text-xs leading-5 text-slate-500">
              <span aria-hidden="true" className="mt-[2px] shrink-0 text-slate-400"><EditorIcon name="pin" /></span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                {day.activities.map((activity, index) => {
                  const name = simplifyPlaceName(activity.name);
                  const isMeal = /^(午餐|晚餐|早餐)/.test(name);
                  return <span key={activity.id} className="inline-flex items-center gap-1.5">
                    {index > 0 && <span aria-hidden="true" className="text-slate-300">→</span>}
                    <span className={isMeal ? 'font-medium text-slate-700' : 'text-slate-600'}>{name}</span>
                  </span>;
                })}
                {day.activities.length === 0 && <span className="text-slate-400">这一天还没有安排</span>}
              </span>
            </p>
          </Button>
        </li>;
      })}
    </ol>
    {!readOnly && <Button disabled={busy} variant="secondary" className="btn-add-day mt-3 w-full justify-center" onClick={onAddDay}>＋ 添加一天</Button>}
  </section>;
}
