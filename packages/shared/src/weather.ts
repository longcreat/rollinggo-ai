import { Type, type Static } from '@sinclair/typebox';

const DateSchema = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
/** 和风天气逐日预报可覆盖的自然日数（含当天）。 */
export const WEATHER_FORECAST_DAYS = 15;
/** 超过这些天只能当趋势参考，不能当确定结论。 */
const WEATHER_DISTANT_DAYS = 7;
export const WeatherCastSchema = Type.Object({
  date: DateSchema,
  dayWeather: Type.String({ minLength: 1, maxLength: 30 }),
  nightWeather: Type.String({ minLength: 1, maxLength: 30 }),
  dayTemp: Type.Number({ minimum: -90, maximum: 70 }),
  nightTemp: Type.Number({ minimum: -90, maximum: 70 }),
  dayWind: Type.String({ maxLength: 30 }),
  nightWind: Type.String({ maxLength: 30 }),
  dayPower: Type.String({ maxLength: 20 }),
  nightPower: Type.String({ maxLength: 20 }),
});
export const WeatherForecastSchema = Type.Object({
  city: Type.String({ minLength: 1, maxLength: 60 }),
  // 和风 LocationID（如 101010100）；不再依赖高德六位 adcode
  locationId: Type.String({ minLength: 1, maxLength: 20 }),
  reportTime: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$' }),
  casts: Type.Array(WeatherCastSchema, { minItems: 1, maxItems: WEATHER_FORECAST_DAYS }),
});
export const TripWeatherSchema = Type.Object({
  destination: Type.String({ maxLength: 100 }),
  checkedAt: Type.Number(),
  status: Type.Union([Type.Literal('available'), Type.Literal('unavailable'), Type.Literal('not_configured'), Type.Literal('not_needed')]),
  forecast: Type.Optional(WeatherForecastSchema),
});
export type WeatherCast = Static<typeof WeatherCastSchema>;
export type WeatherForecast = Static<typeof WeatherForecastSchema>;
export type TripWeather = Static<typeof TripWeatherSchema>;

export function chinaDate(now = Date.now()): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

export function validWeatherDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
}

export type DayWeather = { status: 'available'; cast: WeatherCast; forecast: WeatherForecast; distant: boolean }
  | { status: 'undated' | 'past' | 'pending' | 'unavailable'; label: string; description: string };

/** Always match calendar dates, never cast array position or the trip's day index. */
export function weatherForDate(weather: TripWeather | undefined, destination: string, date: string = '', now = Date.now()): DayWeather {
  if (!validWeatherDate(date)) return { status: 'undated', label: '日期待定', description: '确定出行日期后可查看天气。' };
  const today = chinaDate(now);
  if (date < today) return { status: 'past', label: '已过预报日期', description: '暂不提供历史天气。' };
  const offsetDays = (Date.parse(date) - Date.parse(today)) / 86400_000;
  if (offsetDays > WEATHER_FORECAST_DAYS - 1) return { status: 'pending', label: '预报待更新', description: `和风天气提供未来 ${WEATHER_FORECAST_DAYS} 天预报，临近出行时再来查看。` };
  const forecast = weather?.forecast;
  const reportAt = forecast ? Date.parse(forecast.reportTime.replace(' ', 'T') + '+08:00') : NaN;
  const fresh = weather && weather.checkedAt <= now + 60_000 && now - weather.checkedAt < 3 * 3600_000
    && Number.isFinite(reportAt) && reportAt <= now + 60_000 && now - reportAt < 24 * 3600_000;
  const cast = weather?.destination === destination && weather.status === 'available' && fresh
    ? forecast?.casts.find(item => item.date === date) : undefined;
  if (cast && forecast) return { status: 'available', cast, forecast, distant: offsetDays > WEATHER_DISTANT_DAYS - 1 };
  return { status: 'unavailable', label: '天气暂不可用', description: '暂未获取到这一天的预报，请稍后重试。' };
}
