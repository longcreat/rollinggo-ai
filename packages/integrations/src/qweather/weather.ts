import { Value } from '@sinclair/typebox/value';
import { chinaDate, validWeatherDate, WEATHER_FORECAST_DAYS, WeatherCastSchema, WeatherForecastSchema, type WeatherCast, type WeatherForecast } from '@rollinggo-trip/shared';
import { TtlCache } from '@rollinggo-trip/core/lib/ttlCache';
import { qweatherIdentity, type QWeatherAuth } from '@rollinggo-trip/core/qweatherAuth';
import { qweatherRequest } from './client';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
/** 和风的温度/风力都是字符串；空串与 'NaN' 必须落成 NaN 被判非法，不能当 0。 */
function temperature(value: unknown): number {
  return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/** 和风风向带「风」后缀（东北风），而契约里的 dayWind/nightWind 是纯方位，展示层自己拼「风」。 */
function wind(value: unknown): string {
  return text(value)?.replace(/风$/, '') ?? '';
}

/** updateTime（ISO 带时区）→ 中国时间的 `YYYY-MM-DD HH:mm:ss`，与契约格式一致。 */
export function chinaTimestamp(value: unknown): string | null {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ') : null;
}

/** 和风 `/v7/weather/15d` 的 daily 列表 → 契约 casts。
 * 单日缺字段或值非法只丢弃当天（应用按 date 匹配，不按数组序号），全部非法才返回 null；不伪造缺失字段。 */
export function parseQWeatherDaily(body: Record<string, unknown>, city: string, locationId: string): WeatherForecast | null {
  const reportTime = chinaTimestamp(body.updateTime);
  if (!Array.isArray(body.daily) || body.daily.length === 0 || !reportTime) return null;
  const casts: WeatherCast[] = [];
  for (const entry of body.daily) {
    const item = record(entry);
    const dayWeather = text(item?.textDay);
    const nightWeather = text(item?.textNight);
    if (!item || typeof item.fxDate !== 'string' || !dayWeather || !nightWeather) continue;
    const cast: WeatherCast = {
      date: item.fxDate,
      dayWeather,
      nightWeather,
      dayTemp: temperature(item.tempMax),
      nightTemp: temperature(item.tempMin),
      dayWind: wind(item.windDirDay),
      nightWind: wind(item.windDirNight),
      dayPower: text(item.windScaleDay) ?? '',
      nightPower: text(item.windScaleNight) ?? '',
    };
    if (Value.Check(WeatherCastSchema, cast) && validWeatherDate(cast.date)) casts.push(cast);
  }
  if (new Set(casts.map(item => item.date)).size !== casts.length) return null;
  const forecast = { city, locationId, reportTime, casts };
  return Value.Check(WeatherForecastSchema, forecast) ? forecast : null;
}

/** 城市搜索 → LocationID。同名多候选先按和风自带字段消歧：type=city 优先、rank 小者胜
 * （「西安」市 vs 吉林辽源「西安」区：11-03 实测 number=2 必然把同名区县拉回来，直接一票否决
 * 会让这类城市天气整体不可用）；消歧后仍同 type 且同 rank 才放弃，绝不静默取第一条。 */
export function parseQWeatherCity(body: Record<string, unknown>): { id: string; name: string } | null {
  if (!Array.isArray(body.location)) return null;
  const matches: { id: string; name: string; type: string; rank: number }[] = [];
  for (const entry of body.location) {
    const item = record(entry);
    if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || item.name.length === 0) continue;
    matches.push({
      id: item.id,
      name: item.name,
      type: typeof item.type === 'string' ? item.type : '',
      rank: typeof item.rank === 'string' && /^\d+(\.\d+)?$/.test(item.rank) ? Number(item.rank) : Number.POSITIVE_INFINITY,
    });
  }
  const top = matches[0];
  if (!top) return null;
  const sameName = matches.filter(item => item.name === top.name);
  if (sameName.length <= 1) return { id: top.id, name: top.name };
  const cityOnly = sameName.filter(item => item.type === 'city');
  const pool = cityOnly.length ? cityOnly : sameName;
  const best = pool.reduce((a, b) => (b.rank < a.rank ? b : a));
  if (pool.some(item => item.id !== best.id && item.rank === best.rank)) return null;
  return { id: best.id, name: best.name };
}

/** One city lookup + one daily forecast at most per destination; coalesced and credential-isolated. */
export function createQWeatherLookup(request = qweatherRequest, deadlineMs = 12_000) {
  const cities = new TtlCache<{ id: string; name: string }>(24 * 3600_000, 300);
  const forecasts = new TtlCache<WeatherForecast | null>(3600_000, 300);
  const pending = new Map<string, Promise<WeatherForecast | null>>();
  return async (host: string, auth: QWeatherAuth, destination: string): Promise<WeatherForecast | null> => {
    const identity = qweatherIdentity(auth);
    const cityKey = `${identity}:${destination.trim()}`;
    const key = `${cityKey}:${chinaDate()}`;
    const cached = forecasts.get(key);
    if (cached !== undefined) return cached;
    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size >= 30) return null;
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout>;
    const expired = new Promise<null>(resolve => {
      deadline = setTimeout(() => { controller.abort(); resolve(null); }, deadlineMs);
    });
    const work = (async () => {
      try {
        let city = cities.get(cityKey);
        if (!city) {
          const found = parseQWeatherCity(await request(host, '/geo/v2/city/lookup', new URLSearchParams({ location: destination, number: '2', lang: 'zh' }), auth, 5000, controller.signal));
          if (!found) return null;
          city = found;
          cities.set(cityKey, city);
        }
        // 和风 v7 逐日预报只接受 3d/7d/10d/15d/30d 五档，跨度与共享契约常量同源。
        const body = await request(host, `/v7/weather/${WEATHER_FORECAST_DAYS}d`, new URLSearchParams({ location: city.id, lang: 'zh' }), auth, 5000, controller.signal);
        return parseQWeatherDaily(body, city.name, city.id);
      } catch { return null; }
    })();
    const bounded = Promise.race([work, expired]);
    pending.set(key, bounded);
    try {
      const result = await bounded;
      forecasts.set(key, result, result ? 3600_000 : 60_000);
      return result;
    } finally { clearTimeout(deadline!); pending.delete(key); }
  };
}

export const lookupQWeather = createQWeatherLookup();
