import { Button } from '../ui/Button';
import { dateForDayIndex, type ResearchPoi, type TripDay, type TripWeather } from '@rollinggo-trip/shared';
import { DayWeather } from './DayWeather';
import { legForPair } from '../../lib/tripDerive';
import { useEditorStore } from '../../store/editorStore';
import { ActivityCard } from './ActivityCard';
import { EditorMenu } from './EditorMenu';
import { useState } from 'react';
import { ConfirmDialog, PromptDialog } from '../ui/ActionDialog';
import { handwritingFallback } from '../../lib/handwriting';

interface Props {
  day: TripDay;
  allDays: TripDay[];
  poiByActivityId: Map<string, ResearchPoi>;
  weather?: TripWeather;
  weatherLoading?: boolean;
  onSelectActivity?: (dayIndex: number, activityId: string) => void;
}

export function DaySection({ day, allDays, poiByActivityId, weather, weatherLoading, onSelectActivity }: Props) {
  const readOnly = useEditorStore((s) => s.readOnly);
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  const updateDayTitle = useEditorStore((s) => s.updateDayTitle);
  const deleteDay = useEditorStore((s) => s.deleteDay);
  const startDate = useEditorStore((s) => s.trip?.startDate);
  const destination = useEditorStore((s) => s.trip?.destination ?? '');
  const date = dateForDayIndex(startDate, day.dayIndex);
  const title = day.title || `第${day.dayIndex}天的旅程`;
  return (
    <section className={"day-section [background:var(--color-card)] [border:1px_solid_var(--color-border)] [border-radius:12px] [margin-bottom:12px] overflow-hidden"} aria-label={`第${day.dayIndex}天行程`}>
      <header className={"day-head flex items-center [gap:8px] [padding:8px_10px] [border-left:4px_solid_transparent] [&_.editor-menu-list]:[top:100%] [&_.editor-menu-list]:[bottom:auto]"}>
        <div><h2 style={handwritingFallback(title)}>{title}</h2><p className="flex flex-wrap items-center gap-2">{date && <span>{`${date.slice(5).replace('-', '月')}日`}</span>}<DayWeather weather={weather} destination={destination} date={date} loading={weatherLoading} /></p></div>
        {!readOnly && <EditorMenu label="当天更多操作">
          <Button variant="ghost" onClick={() => setDialog('rename')}>修改当日主题</Button>
          <Button variant="danger" onClick={() => setDialog('delete')}>删除这一天</Button>
        </EditorMenu>}
      </header>
      <div className={"day-body [padding:4px_10px_10px] flex flex-col [gap:8px]"}>
        {day.activities.length === 0 && <p className={"muted [color:var(--color-muted)] [font-size:0.88rem] day-empty text-center [padding:8px_0]"}>这一天还没有安排，让旅行助手补上想去的活动吧。</p>}
        {day.activities.map((activity, index) => {
          const next = day.activities[index + 1];
          return (
            <ActivityCard
              key={activity.id}
              day={day}
              activity={activity}
              index={index}
              allDays={allDays}
              matchedPoi={poiByActivityId.get(activity.id)}
              nextLeg={next ? legForPair(day, activity.id, next.id) : undefined}
              onSelectActivity={onSelectActivity}
            />
          );
        })}
      </div>
      {dialog === 'rename' && <PromptDialog title="修改当日主题" initialValue={day.title} maxLength={30} onConfirm={(title) => updateDayTitle(day.id, title)} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && <ConfirmDialog title="删除这一天" description={`确定删除第${day.dayIndex}天及其中的 ${day.activities.length} 个活动？`} onConfirm={() => deleteDay(day.id)} onClose={() => setDialog(null)} />}
    </section>
  );
}
