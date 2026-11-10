import { Button } from '../ui/Button';
import { Select } from '../ui/Field';
import { useState } from 'react';
import type { Activity, ResearchPoi, TransitLeg, TripDay } from '@rollinggo-trip/shared';
import { hasValidCoord } from '../../lib/colors';
import { RouteOptions } from './RouteOptions';
import { useEditorStore } from '../../store/editorStore';
import { PoiCover, ReservationBadge } from '../PoiCard';
import { ConfirmDialog } from '../ui/ActionDialog';
import { EditorIcon } from './EditorIcon';
import { EditorMenu } from './EditorMenu';
import { ActivityDetailModal } from './ActivityDetailModal';
import { ClockIcon } from '../home/HomeIcons';

interface Props {
  day: TripDay;
  activity: Activity;
  index: number;
  allDays: TripDay[];
  matchedPoi?: ResearchPoi;
  nextLeg?: TransitLeg;
  onSelectActivity?: (dayIndex: number, activityId: string) => void;
}

export function ActivityCard({
  day,
  activity,
  index,
  allDays,
  matchedPoi,
  nextLeg,
  onSelectActivity,
}: Props) {
  const readOnly = useEditorStore((s) => s.readOnly);
  const moveActivity = useEditorStore((s) => s.moveActivity);
  const moveActivityToDay = useEditorStore((s) => s.moveActivityToDay);
  const deleteActivity = useEditorStore((s) => s.deleteActivity);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [failedCover, setFailedCover] = useState<string>();

  const descriptionText = activity.description || matchedPoi?.intro;

  const handleCardClick = () => {
    onSelectActivity?.(day.dayIndex, activity.id);
    setDetailOpen(true);
  };

  return (
    <article id={`activity-${activity.id}`} className="activity-entry" aria-label={activity.name}>
      {/* 极简轻量景点卡片：点击弹出完整详情 */}
      <div
        onClick={handleCardClick}
        className="group relative flex flex-col gap-2 rounded-2xl border border-slate-200/80 bg-white/90 p-3.5 sm:p-4 shadow-xs transition-all hover:border-slate-300 hover:shadow-md hover:bg-white cursor-pointer"
      >
        {/* 卡片头部：序号、标题、操作菜单 */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className="flex h-8 w-8 sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 border border-slate-200/60 font-bold text-xs sm:text-sm text-slate-800 shadow-2xs">
              {String(index + 1).padStart(2, '0')}
            </span>
            <h3 className="m-0 truncate font-bold text-sm sm:text-base text-ink group-hover:text-slate-700 transition-colors">
              {activity.name}
            </h3>
          </div>

          <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
            {!readOnly && (
              <EditorMenu label={`${activity.name}更多操作`}>
                <Button variant="ghost" type="button" disabled={index === 0} onClick={() => moveActivity(day.id, activity.id, 'up')}>
                  上移
                </Button>
                <Button variant="ghost" type="button" disabled={index === day.activities.length - 1} onClick={() => moveActivity(day.id, activity.id, 'down')}>
                  下移
                </Button>
                {allDays.length > 1 && (
                  <label className="block p-1">
                    <span className="block text-xs text-ink-muted mb-1">移至其他天</span>
                    <Select
                      aria-label="移至其他天"
                      value=""
                      onChange={(e) => {
                        if (e.target.value) moveActivityToDay(day.id, activity.id, e.target.value);
                      }}
                    >
                      <option value="">选择天数</option>
                      {allDays.filter((d) => d.id !== day.id).map((d) => (
                        <option key={d.id} value={d.id}>
                          第{d.dayIndex}天
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
                <Button variant="danger" type="button" onClick={() => setDeleteOpen(true)}>
                  删除活动
                </Button>
              </EditorMenu>
            )}
          </div>
        </div>

        {/* 卡片主体：摘要信息 + 右侧小封面 */}
        <div className="flex items-start justify-between gap-3 pt-1">
          <div className="min-w-0 flex-1 flex flex-col gap-1.5">
            {/* 关键元数据标签 */}
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-ink-muted font-medium">
                <EditorIcon name="place" />
                <span>{activity.category}</span>
              </span>

              {activity.startTime && activity.endTime && (
                <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-slate-700 font-medium">
                  <ClockIcon className="h-3 w-3" />
                  <span>{activity.startTime} ~ {activity.endTime}</span>
                </span>
              )}

              {matchedPoi?.reservation === 'required' && (
                <ReservationBadge poi={matchedPoi} />
              )}

              {activity.cost !== undefined && activity.cost > 0 && (
                <span className="rounded-md bg-amber-50 px-2 py-0.5 text-amber-700 font-medium">
                  ¥{activity.cost}
                </span>
              )}

              {!hasValidCoord(activity) && (
                <span className="rounded-md bg-rose-50 px-2 py-0.5 text-rose-600">
                  无坐标
                </span>
              )}
            </div>

            {/* 一句话核心摘要（最多截断展示两行，绝不占满视线） */}
            {descriptionText && (
              <p className="m-0 line-clamp-2 text-xs leading-relaxed text-ink-muted">
                {descriptionText}
              </p>
            )}

            <div className="flex items-center gap-1 text-[11px] font-medium text-slate-500 group-hover:text-slate-800 pt-0.5">
              <span>查看详情与攻略</span>
              <span>›</span>
            </div>
          </div>

          {/* 右侧小封面图（72x72 精美圆角） */}
          {matchedPoi && (
            <div className="shrink-0 overflow-hidden rounded-xl border border-slate-200/60 bg-slate-100 shadow-2xs h-[68px] w-[68px] sm:h-[72px] sm:w-[72px]">
              <PoiCover
                key={matchedPoi.coverUrl}
                poi={matchedPoi}
                variant="thumbnail"
                onCoverError={setFailedCover}
              />
            </div>
          )}
        </div>
      </div>

      {/* 两景点之间的交通连接段 */}
      {index < day.activities.length - 1 && (
        <div className="mt-2">
          <RouteOptions dayId={day.id} fromId={activity.id} leg={nextLeg} />
          {/* 若长距离步行（>20分钟），给出智能出行贴士 */}
          {nextLeg && nextLeg.mode === 'walk' && nextLeg.durationMin > 20 && (
            <div className="mt-1 flex items-center justify-between rounded-xl bg-amber-50/80 border border-amber-200/60 px-3 py-1.5 text-xs text-amber-900">
              <span className="flex items-center gap-1.5">
                <span>🚕</span>
                <span>步行距离较远（约 {Math.round(nextLeg.distanceM / 1000 * 10) / 10} km），建议乘坐网约车或公共交通</span>
              </span>
              <span className="text-[11px] font-medium text-amber-700">
                打车约 {Math.max(5, Math.round(nextLeg.durationMin / 4))} 分钟
              </span>
            </div>
          )}
        </div>
      )}

      {/* 景点详细信息抽屉/弹窗 */}
      {detailOpen && (
        <ActivityDetailModal
          activity={activity}
          matchedPoi={matchedPoi}
          onClose={() => setDetailOpen(false)}
          onCenterMap={() => onSelectActivity?.(day.dayIndex, activity.id)}
        />
      )}

      {/* 删除确认弹窗 */}
      {deleteOpen && (
        <ConfirmDialog
          title="删除活动"
          description={`确定删除「${activity.name}」？`}
          onClose={() => setDeleteOpen(false)}
          onConfirm={() => deleteActivity(day.id, activity.id)}
        />
      )}
    </article>
  );
}
