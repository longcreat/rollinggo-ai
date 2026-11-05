import { useState } from 'react';
import { Modal } from '../Modal';
import { Button } from '../ui/Button';
import { ChinaMap, type MapCityDot } from './ChinaMap';
import { DestinationImage, DestinationShowcase, destinationDescription } from './DestinationShowcase';
import { PinIcon } from './HomeIcons';
import { NavigationIcon } from '../NavigationIcon';

export function DestinationPicker({ cities, mapCities, contextCities, selected, notice, onConfirm, onClose }: {
  cities: string[]; mapCities: MapCityDot[]; contextCities: MapCityDot[]; selected: string | null;
  notice: string | null;
  onConfirm: (city: string) => void; onClose: () => void;
}) {
  const [draftCity, setCandidate] = useState(selected ?? '');
  const candidate = draftCity.trim() || null;
  return <Modal size="screen" title="选择目的地" onClose={onClose}>
    <div className="mx-auto max-w-2xl [--ui:1px]">
      {/* 任意城市搜索与输入框 */}
      <div className="mb-3 flex items-center gap-2.5 rounded-2xl border border-brand/25 bg-white px-3.5 py-2.5 shadow-sm focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20">
        <span className="text-brand text-base">🔍</span>
        <input
          type="text"
          placeholder="搜索或输入全国任意城市（如：大理、三亚、洛阳、南京、景德镇...）"
          value={draftCity}
          onChange={(e) => setCandidate(e.target.value)}
          className="w-full border-0 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
        />
        {draftCity && (
          <button type="button" onClick={() => setCandidate('')} className="p-1 text-xs text-ink-muted hover:text-ink cursor-pointer">
            ✕
          </button>
        )}
      </div>

      {notice ? <p role="status" className="my-8 text-center text-sm leading-6 text-ink-muted">{notice}</p>
        : <ChinaMap cities={mapCities} contextCities={contextCities} selected={candidate} onSelect={setCandidate} mode="picker" />}
      <div className="mt-2 rounded-t-[28px] rounded-b-2xl bg-white/85 p-4 shadow-[0_-8px_40px_rgba(31,64,124,0.04)]">
        <div className="mx-auto mb-5 h-1 w-8 rounded-full bg-brand/15" aria-hidden="true" />
        {candidate ? <div className="mb-5 flex items-center gap-3">
          <DestinationImage key={candidate} city={candidate} className="h-16 w-16 shrink-0 rounded-xl" />
          <div className="min-w-0">
            <h3 className="m-0 flex items-center gap-1 text-lg font-semibold text-ink">
              <PinIcon className="h-5 w-5 text-brand" />{candidate}
            </h3>
            <p className="mb-0 mt-1 text-xs leading-5 text-ink-muted">
              {destinationDescription(candidate) || '全国热门旅游目的地，支持全网实时检索生成专属攻略'}
            </p>
          </div>
        </div> : <p className="mb-5 mt-0 text-sm leading-6 text-ink-muted">输入上方搜索框、点击地图或选择下方推荐城市。</p>}
        <Button variant="plain" disabled={!candidate || Boolean(notice)} onClick={() => { if (candidate && !notice) onConfirm(candidate); }} className="relative flex min-h-14 w-full items-center justify-center rounded-full bg-gradient-to-r from-brand-sky to-brand px-12 text-base font-semibold text-white disabled:opacity-45 cursor-pointer">
          确认目的地：{candidate ?? '未选择'}<span className="absolute right-2 grid h-10 w-10 place-items-center rounded-full bg-white text-brand"><NavigationIcon name="arrow" /></span>
        </Button>
        <div className="mt-5"><DestinationShowcase cities={cities} selected={candidate} onSelect={setCandidate} /></div>
        <details className="mt-4 text-sm text-ink-muted">
          <summary className="cursor-pointer py-3 focus-visible:outline-2 focus-visible:outline-brand">精选已覆盖城市 · {cities.length}</summary>
          <div className="grid grid-cols-3 gap-2 pb-2">{cities.map(city => <Button variant="plain" key={city} aria-pressed={candidate === city} onClick={() => setCandidate(city)} className={`min-h-11 rounded-xl px-2 cursor-pointer ${candidate === city ? 'bg-brand/10 text-brand' : 'bg-canvas text-ink'}`}>{city}</Button>)}</div>
        </details>
      </div>
    </div>
  </Modal>;
}
