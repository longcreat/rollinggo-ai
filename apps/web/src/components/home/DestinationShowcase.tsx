import { useState } from 'react';
import { Button } from '../ui/Button';
import { PinIcon } from './HomeIcons';

const images = import.meta.glob<string>('../../assets/destinations/*.webp', { eager: true, query: '?url', import: 'default' });
const landmarks = import.meta.glob<string>('../../assets/city-landmarks/*.png', { eager: true, query: '?url', import: 'default' });
const descriptions: Record<string, string> = {
  北京: '千年古都 · 历史人文', 上海: '摩登魅力 · 都市潮流', 成都: '烟火成都 · 慢生活',
  杭州: '湖山相映 · 江南诗意', 济南: '泉水人家 · 山湖之间', 广州: '岭南风味 · 悠然寻味',
  重庆: '山城夜色 · 街巷漫游', 厦门: '海风轻拂 · 岛屿时光', 西安: '古城寻迹 · 长安风韵', 南京: '金陵旧事 · 山水城林',
};
export function destinationDescription(city: string) { return descriptions[city.replace(/市$/, '')] ?? '发现街巷风景，开启城市漫游'; }

export function featuredDestinations(cities: string[]) {
  const priority = ['北京', '杭州', '厦门'];
  return [...cities.filter(city => priority.includes(city.replace(/市$/, ''))).sort((a, b) => priority.indexOf(a.replace(/市$/, '')) - priority.indexOf(b.replace(/市$/, ''))), ...cities.filter(city => !priority.includes(city.replace(/市$/, '')))];
}

export function DestinationImage({ city, className = '' }: { city: string; className?: string }) {
  const name = city.replace(/市$/, '');
  const photo = images[`../../assets/destinations/${name}.webp`];
  const illustration = landmarks[`../../assets/city-landmarks/${name}.png`];
  const [failed, setFailed] = useState<string[]>([]);
  const source = photo && !failed.includes(photo) ? photo : illustration && !failed.includes(illustration) ? illustration : undefined;
  return <div className={`relative overflow-hidden bg-gradient-to-br from-brand-sky/25 to-brand/10 ${className}`}>
    {source ? <img src={source} alt={`${city}${source === photo ? '城市风景' : '地标插画'}`} loading="lazy" className={`h-full w-full ${source === photo ? 'object-cover' : 'object-contain p-3 box-border opacity-65'}`} onError={() => setFailed(previous => [...previous, source])} />
      : <div role="img" aria-label={`${city}城市图片暂缺`} className="grid h-full w-full place-items-center text-brand/60"><PinIcon className="h-9 w-9" /></div>}
  </div>;
}

export function DestinationShowcase({ cities, selected, onSelect, onMore }: {
  cities: string[]; selected: string | null; onSelect: (city: string) => void; onMore?: () => void;
}) {
  if (!cities.length) return null;
  return <section aria-label="目的地精选" className="min-w-0">
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="m-0 text-lg font-semibold text-ink">目的地精选</h2>
      {onMore && <Button variant="plain" className="flex min-h-11 items-center gap-1 text-xs text-ink-muted" onClick={onMore}>查看全部<span aria-hidden="true">›</span></Button>}
    </div>
    <div className="grid grid-cols-3 gap-2.5">
      {featuredDestinations(cities).slice(0, 3).map(city => <Button key={city} variant="plain" aria-label={`选择${city}`} aria-pressed={selected === city} onClick={() => onSelect(city)}
        className={`min-w-0 overflow-hidden rounded-2xl bg-white/75 p-0 text-left shadow-sm transition-colors ${selected === city ? 'ring-2 ring-brand' : 'hover:bg-white'}`}>
        <DestinationImage city={city} className="aspect-[1.2] w-full" />
        <div className="px-2 py-2.5"><span className="block text-sm font-semibold text-ink">{city}</span><span className="mt-1 block truncate text-[11px] leading-5 text-ink-muted">{destinationDescription(city)}</span></div>
      </Button>)}
    </div>
  </section>;
}
