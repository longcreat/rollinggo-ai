import { useState } from 'react';
import type { Activity, ResearchPoi } from '@rollinggo-trip/shared';
import { Modal } from '../Modal';
import { Button } from '../ui/Button';
import { PoiCover, ReservationBadge, PhotoCredit } from '../PoiCard';
import { EditorIcon } from './EditorIcon';
import { CloseIcon, PinIcon, ClockIcon } from '../home/HomeIcons';

interface ActivityDetailModalProps {
  activity: Activity;
  matchedPoi?: ResearchPoi;
  onClose: () => void;
  onCenterMap?: () => void;
}

export function ActivityDetailModal({
  activity,
  matchedPoi,
  onClose,
  onCenterMap,
}: ActivityDetailModalProps) {
  const [activePhotoIndex, setActivePhotoIndex] = useState(0);
  const photos = matchedPoi?.photos ?? (matchedPoi?.coverUrl ? [{ url: matchedPoi.coverUrl }] : []);
  const currentPhoto = photos[activePhotoIndex];

  return (
    <Modal title={activity.name} onClose={onClose} size="sheet">
      <div className="flex flex-col gap-5 p-1 sm:p-2">
        {/* 顶部图片画廊 */}
        {photos.length > 0 ? (
          <div className="relative overflow-hidden rounded-2xl bg-slate-100 shadow-inner">
            <div className="aspect-[16/9] w-full max-h-[320px]">
              <img
                src={currentPhoto?.url}
                alt={activity.name}
                className="h-full w-full object-cover"
              />
            </div>
            {/* 多图缩略切换 */}
            {photos.length > 1 && (
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-black/40 px-3 py-1.5 backdrop-blur-md">
                {photos.map((p, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setActivePhotoIndex(idx)}
                    className={`h-2 rounded-full transition-all cursor-pointer ${
                      activePhotoIndex === idx ? 'w-6 bg-white' : 'w-2 bg-white/50 hover:bg-white/80'
                    }`}
                    aria-label={`切换到第 ${idx + 1} 张图片`}
                  />
                ))}
              </div>
            )}
            {matchedPoi?.coverAttribution && (
              <div className="absolute right-3 bottom-3 rounded-lg bg-black/50 px-2.5 py-1 text-[11px] text-white/90 backdrop-blur-md">
                <PhotoCredit poi={matchedPoi} />
              </div>
            )}
          </div>
        ) : (
          <div className="flex aspect-[16/9] max-h-[180px] w-full items-center justify-center rounded-2xl bg-gradient-to-br from-slate-100 to-slate-200/80 text-ink-muted">
            <div className="flex flex-col items-center gap-2 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/80 text-2xl shadow-xs">
                {activity.category === '美食' ? '🍜' : activity.category === '住宿' ? '🏨' : '🏞️'}
              </span>
              <span className="text-xs font-medium text-ink-soft">暂无实景照片</span>
            </div>
          </div>
        )}

        {/* 标题与核心元数据胶囊 */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="m-0 text-xl font-bold text-ink sm:text-2xl">{activity.name}</h2>
            {onCenterMap && (
              <Button
                variant="secondary"
                type="button"
                onClick={() => {
                  onCenterMap();
                  onClose();
                }}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-all cursor-pointer shadow-2xs"
              >
                <PinIcon className="h-3.5 w-3.5 text-slate-600" />
                <span>在地图中定位</span>
              </Button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-ink-soft">
              <EditorIcon name="place" />
              <span>{activity.category}</span>
            </span>

            {activity.startTime && activity.endTime && (
              <span className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-ink-soft">
                <ClockIcon className="h-3 w-3 text-slate-500" />
                <span>{activity.startTime} ~ {activity.endTime}</span>
              </span>
            )}

            {activity.cost !== undefined && activity.cost > 0 && (
              <span className="inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800">
                <span>门票/人均约 ¥{activity.cost}</span>
              </span>
            )}

            {matchedPoi && (
              <ReservationBadge poi={matchedPoi} />
            )}

            {activity.openTime && (
              <span className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-ink-muted">
                <span>开放时间：{activity.openTime}</span>
              </span>
            )}
          </div>
        </div>

        {/* 详细游玩指南与介绍 */}
        <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-4 leading-relaxed">
          <h3 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">
            景点概览与游览建议
          </h3>
          <p className="m-0 text-sm font-normal text-ink-soft whitespace-pre-wrap leading-6">
            {activity.description || matchedPoi?.intro || '暂无详细介绍，建议提前向景区咨询开放状况。'}
          </p>
        </div>

        {/* 预约说明与出行提示 */}
        {matchedPoi?.reservationNote && (
          <div className="rounded-xl border border-amber-200/70 bg-amber-50/70 p-3 text-xs text-amber-900 leading-5">
            <span className="font-semibold">预约提示：</span>
            <span>{matchedPoi.reservationNote}</span>
          </div>
        )}

        {/* 外部参考来源 */}
        {((activity.sourceNotes && activity.sourceNotes.length > 0) || (matchedPoi?.sourceLinks && matchedPoi.sourceLinks.length > 0)) && (
          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-100">
            <span className="text-xs text-ink-muted">信息来源：</span>
            {(activity.sourceNotes || matchedPoi?.sourceLinks || []).map((s, idx) => (
              <a
                key={idx}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-md bg-white border border-slate-200 px-2 py-0.5 text-xs text-slate-700 hover:text-slate-950 hover:border-slate-300 hover:underline"
              >
                <span>{s.title || '参考资料'}</span>
                <span className="text-[10px]">↗</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
