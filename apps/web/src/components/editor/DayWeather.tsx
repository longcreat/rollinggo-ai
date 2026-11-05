import { weatherForDate, type TripWeather } from '@tripweaver/shared';

function WeatherIcon({ condition, className = 'size-5' }: { condition: string; className?: string }) {
  const path = /雪/.test(condition) ? 'M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M8 4l4 3 4-3M8 20l4-3 4 3'
    : /雨/.test(condition) ? 'M6 15a4 4 0 0 1-1-7 6 6 0 0 1 11-2 4.5 4.5 0 0 1 2 9H6ZM8 18l-1 3M13 18l-1 3M18 18l-1 3'
    : /晴/.test(condition) ? 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1'
    : 'M6 18a5 5 0 0 1-1-10 6 6 0 0 1 11-2 6 6 0 0 1 2 12H6Z';
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={`${className} shrink-0`}><path d={path} /></svg>;
}

// 只出「图标 + 天气 + 温度」这一行，行内渲染（`inline-flex`）方便塞进「第N天」那一行或日期行右端；
// 白天/夜间风力、数据来源与更新时间和未配置说明都不展示，需要细节时看总览页的出行建议与注意事项。
export function DayWeather({ weather, destination, date, loading = false, compact = false }: {
  weather?: TripWeather; destination: string; date?: string; loading?: boolean; compact?: boolean;
}) {
  const daily = weatherForDate(weather, destination, date);
  const scale = compact ? 'size-4' : 'size-5';
  const text = compact ? 'text-xs leading-5' : 'text-sm leading-6';
  // 「没接入数据源」和「查了没拿到」必须分开说：前者重试再多也没用。
  const unconfigured = weather?.status === 'not_configured' && daily.status === 'unavailable';
  if (daily.status !== 'available') return <span className={`day-weather inline-flex flex-wrap items-center gap-x-2 gap-y-1 ${text} text-[var(--editor-muted)]`}>
    <WeatherIcon condition="" className={scale} />
    <span>{loading && daily.status === 'unavailable' ? '天气查询中…' : unconfigured ? '天气服务未配置' : daily.label}</span>
  </span>;
  const { cast } = daily;
  const condition = cast.dayWeather === cast.nightWeather ? cast.dayWeather : `${cast.dayWeather}转${cast.nightWeather}`;
  const low = Math.min(cast.dayTemp, cast.nightTemp);
  const high = Math.max(cast.dayTemp, cast.nightTemp);
  return <span className={`day-weather inline-flex flex-wrap items-center gap-x-2 gap-y-1 ${text}`}>
    <span className="text-amber-500/90"><WeatherIcon condition={condition} className={scale} /></span>
    <span>{condition}</span><span className="font-medium tabular-nums">{low}–{high}℃</span>
  </span>;
}
