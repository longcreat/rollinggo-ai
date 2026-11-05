// 调研候选卡片：生成页实时候选（compact）与编辑器概览（完整）共用
// 封面来源：canonical_places.payload.coverImage（上游导出的 webp，走 /media 同源相对路径）
// 与维基降级的热链 http(s) URL；加载失败/缺图回落类目占位图
import { useState } from 'react';
import { Modal } from './Modal';
import { Button } from './ui/Button';
import type { PoiPhoto, ResearchPoi } from '@tripweaver/shared';
import { POI_CATEGORY_ICON, POI_CATEGORY_LABEL, RESERVATION_LABEL } from '../lib/poi';

// 预约徽章与封面图导出复用：活动卡片内嵌候选信息（概览并入行程）沿用同一渲染与兜底逻辑
export function ReservationBadge({ poi }: { poi: ResearchPoi }) {
  return (
    <span
      className={`rsv-badge rounded-full [padding:1px_8px] [font-size:0.72rem] whitespace-nowrap ${poi.reservation === 'required' ? "rsv-required [background:var(--color-rsv-required-background-12)] [color:var(--color-rsv-required-color-13)] font-semibold" : poi.reservation === 'none' ? "rsv-none [background:var(--color-rsv-none-background-14)] [color:var(--color-rsv-none-color-15)]" : "rsv-unknown [background:var(--color-rsv-unknown-background-16)] [color:var(--color-muted)]"}`}
      title={poi.reservation === 'required' && poi.reservationNote ? poi.reservationNote : undefined}
    >
      {RESERVATION_LABEL[poi.reservation]}
    </span>
  );
}

export function PoiCover({ poi, onCoverError, variant = 'thumbnail' }: { poi: ResearchPoi; onCoverError?: (url: string) => void; variant?: 'thumbnail' | 'photo' }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  if (!poi.coverUrl || failedUrl === poi.coverUrl) {
    return (
      <span className={"poi-cover [width:72px] [height:72px] [border-radius:8px] [object-fit:cover] shrink-0 poi-cover-fallback inline-flex items-center justify-center [font-size:1.6rem] [background:var(--color-poi-cover-fallback-background-11)]"} aria-hidden="true">
        {POI_CATEGORY_ICON[poi.category]}
      </span>
    );
  }
  if (variant === 'photo') {
    return <PoiPhotoGallery key={poi.coverUrl} poi={poi} onCoverError={onCoverError} />;
  }
  return (
    <img
      className={"poi-cover [width:72px] [height:72px] [border-radius:8px] [object-fit:cover] shrink-0"}
      src={poi.coverUrl}
      alt={poi.name}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => {
        setFailedUrl(poi.coverUrl);
        if (poi.coverUrl) onCoverError?.(poi.coverUrl);
      }}
    />
  );
}

/** 缓存图也保留作品作者、出处与许可；不把上游 HTML 插入页面。只在放大弹窗内展示，卡片位置一律不渲染（2026-10-02 产品决定）。 */
const PHOTO_SOURCE_NAMES = { pexels: 'Pexels', commons: 'Wikimedia Commons', unsplash: 'Unsplash', pixabay: 'Pixabay', xhs: '小红书' } satisfies Record<NonNullable<PoiPhoto['attribution']>['source'], string>;
export function PhotoCredit({ poi }: { poi: Pick<ResearchPoi, 'coverUrl' | 'coverAttribution'> }) {
  const credit = poi.coverAttribution;
  if (!poi.coverUrl || !credit || !safeCreditUrl(credit.sourceUrl) || !safeCreditUrl(credit.licenseUrl)) return null;
  return <p className="photo-credit m-0 text-[10px] leading-normal text-ink-muted break-words">
    <a href={credit.photographerUrl && safeCreditUrl(credit.photographerUrl) ? credit.photographerUrl : credit.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-inherit underline">{credit.photographer}</a>
    {' · '}<a href={credit.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-inherit underline">{PHOTO_SOURCE_NAMES[credit.source]}</a>
    {' · '}<a href={credit.licenseUrl} target="_blank" rel="noopener noreferrer" className="text-inherit underline">{credit.license}</a>
  </p>;
}

/** 卡片只显示首选；切换和失败状态只存在于当前照片浏览器，不改行程快照。 */
function PoiPhotoGallery({ poi, onCoverError }: { poi: ResearchPoi; onCoverError?: (url: string) => void }) {
  const [opened, setOpened] = useState(false);
  const [selectedUrl, setSelectedUrl] = useState<string>();
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const [loadedPhoto, setLoadedPhoto] = useState<{ url: string; portrait: boolean }>();
  const candidates: PoiPhoto[] = poi.coverUrl ? [{ url: poi.coverUrl, attribution: poi.coverAttribution }, ...(poi.photos ?? [])] : [];
  const photos = candidates.filter((photo, index) => candidates.findIndex(entry => entry.url === photo.url) === index).slice(0, 3)
    .filter(photo => !failedUrls.includes(photo.url));
  const cover = photos.find(photo => photo.url === poi.coverUrl);
  const selected = photos.find(photo => photo.url === selectedUrl) ?? cover;
  const portrait = loadedPhoto?.url === cover?.url && loadedPhoto?.portrait;
  const fail = (url: string) => {
    setFailedUrls(previous => previous.includes(url) ? previous : [...previous, url]);
    if (url === poi.coverUrl || photos.every(photo => photo.url === url)) {
      setOpened(false);
      if (poi.coverUrl) onCoverError?.(poi.coverUrl);
    }
  };
  if (!cover || !selected) return <span className="poi-cover-fallback inline-flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-lg bg-[var(--color-poi-cover-fallback-background-11)] text-[1.6rem]" aria-hidden="true">{POI_CATEGORY_ICON[poi.category]}</span>;
  const index = photos.indexOf(selected);
  const move = (offset: number) => setSelectedUrl(photos[(index + offset + photos.length) % photos.length]?.url);
  return <>
    <Button variant="plain" className={`poi-photo-trigger inline-flex min-h-11 min-w-11 w-full cursor-zoom-in items-center justify-center rounded-lg border-0 bg-transparent p-0`} aria-label={`查看${poi.name}完整照片`} onClick={() => { setSelectedUrl(cover.url); setOpened(true); }}>
      <img key={cover.url} className={`poi-photo block h-auto w-auto min-w-0 max-w-full rounded-lg object-contain ${portrait ? 'max-h-[150px] max-sm:max-h-[110px]' : 'max-h-[120px] max-sm:max-h-[88px]'}`} src={cover.url} alt={poi.name} loading="lazy" referrerPolicy="no-referrer" onLoad={event => setLoadedPhoto({ url: cover.url, portrait: event.currentTarget.naturalHeight > event.currentTarget.naturalWidth })} onError={() => fail(cover.url)} />
    </Button>
    {opened && <Modal title={poi.name} size="photo" onClose={() => setOpened(false)}>
      <div className="poi-photo-viewer" onKeyDown={event => {
        if (photos.length < 2 || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault(); move(event.key === 'ArrowRight' ? 1 : -1);
      }}>
        <img key={selected.url} className="poi-photo-expanded mx-auto mb-3 block h-auto w-auto max-h-[calc(100dvh-300px)] max-w-full object-contain" src={selected.url} alt={`${poi.name} · 第${index + 1}张照片`} referrerPolicy="no-referrer" onError={() => fail(selected.url)} />
        {photos.length > 1 && <>
          <div className="mb-3 flex items-center justify-center gap-4">
            <Button variant="ghost" aria-label="上一张照片" onClick={() => move(-1)}>← 上一张</Button>
            <span className="min-w-10 text-center text-sm text-ink-muted" role="status" aria-live="polite">{index + 1} / {photos.length}</span>
            <Button variant="ghost" aria-label="下一张照片" onClick={() => move(1)}>下一张 →</Button>
          </div>
          <div className="mb-3 flex justify-center gap-2" role="group" aria-label="选择照片">
            {photos.map((photo, i) => <Button variant="plain" key={photo.url} aria-label={`查看第${i + 1}张照片`} aria-pressed={photo.url === selected.url} onClick={() => setSelectedUrl(photo.url)} className={`h-12 w-16 overflow-hidden rounded-md border-2 p-0 ${photo.url === selected.url ? 'border-brand' : 'border-transparent'}`}>
              <img className="h-full w-full object-cover" src={photo.url} alt="" referrerPolicy="no-referrer" onError={() => fail(photo.url)} />
            </Button>)}
          </div>
        </>}
        <PhotoCredit poi={{ coverUrl: selected.url, coverAttribution: selected.attribution }} />
      </div>
    </Modal>}
  </>;
}

function safeCreditUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['www.pexels.com', 'commons.wikimedia.org', 'creativecommons.org', 'unsplash.com', 'pixabay.com', 'www.xiaohongshu.com'].includes(url.hostname);
  } catch { return false; }
}

export function PoiCard({ poi, compact = false }: { poi: ResearchPoi; compact?: boolean }) {
  if (compact) {
    // 紧凑卡（生成时间线）：小图 / 名称 / 类目徽章 / 预约徽章
    return (
      <div className={"poi-card flex [border:1px_solid_var(--color-border)] [border-radius:10px] [background:var(--color-activity-card-background-6)] min-w-0 poi-card-compact [padding:8px] [gap:8px] items-center [&_.poi-cover]:[width:44px] [&_.poi-cover]:[height:44px] [&_.poi-cover-fallback]:[font-size:1.2rem] [&_.poi-name]:[font-size:0.86rem] [&_.poi-name]:whitespace-nowrap [&_.poi-body]:[gap:3px]"}>
        <PoiCover poi={poi} />
        <div className={"poi-body min-w-0 flex-1 flex flex-col [gap:4px]"}>
          <span className={"poi-name font-semibold [font-size:0.92rem] overflow-hidden [text-overflow:ellipsis]"}>{poi.name}</span>
          <span className={"poi-badges flex [gap:6px] items-center flex-wrap"}>
            <span className={"poi-cat [font-size:0.72rem] [color:var(--color-primary-dark)] [background:var(--color-quota-chip-background-2)] rounded-full [padding:1px_8px] whitespace-nowrap"}>{POI_CATEGORY_LABEL[poi.category]}</span>
            <ReservationBadge poi={poi} />
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className={"poi-card flex items-start [gap:10px] [border:1px_solid_var(--color-border)] [border-radius:10px] [padding:10px] [background:var(--color-activity-card-background-6)] min-w-0"}>
      <div className={"poi-body min-w-0 flex-1 flex flex-col [gap:4px]"}>
        <div className={"poi-line1 flex items-center [gap:8px] flex-wrap"}>
          <span className={"poi-name font-semibold [font-size:0.92rem] overflow-hidden [text-overflow:ellipsis]"}>{poi.name}</span>
          <span className={"poi-cat [font-size:0.72rem] [color:var(--color-primary-dark)] [background:var(--color-quota-chip-background-2)] rounded-full [padding:1px_8px] whitespace-nowrap"}>{POI_CATEGORY_LABEL[poi.category]}</span>
          <ReservationBadge poi={poi} />
        </div>
        {poi.intro && <p className={"poi-intro m-0 [font-size:0.82rem] [color:var(--color-muted)] [display:-webkit-box] [-webkit-line-clamp:2] [-webkit-box-orient:vertical] overflow-hidden"}>{poi.intro}</p>}
        {poi.reservation === 'required' && poi.reservationNote && <p className={"poi-rsv-note m-0 [font-size:0.78rem] [color:var(--color-tag-warn-color-8)]"}>📌 {poi.reservationNote}</p>}
        {poi.sourceLinks.length > 0 && (
          <p className={"poi-links m-0 flex [gap:6px] flex-wrap"}>
            {poi.sourceLinks.slice(0, 3).map((s) => (
              <a key={s.url} className={"tag [border-radius:4px] [padding:1px_6px] [font-size:0.72rem] tag-source [background:var(--color-quota-chip-background-2)] [color:var(--color-tag-source-color-5)]"} href={s.url} target="_blank" rel="noopener noreferrer">
                🔗 {s.title || '来源'}
              </a>
            ))}
          </p>
        )}
      </div>
      <PoiCover key={poi.coverUrl} poi={poi} variant="photo" />
    </div>
  );
}
