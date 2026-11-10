import { chinaDate, dateForDayIndex, validWeatherDate, WEATHER_FORECAST_DAYS, type Trip, type TripWeather } from '@rollinggo-trip/shared';
import { lookupQWeather } from '@rollinggo-trip/integrations/qweather/weather';

/** Lazy env binding keeps pure date/no-date paths independent of credentials and DB. */
export async function getTripWeather(trip: Trip): Promise<TripWeather> {
  const checkedAt = Date.now();
  const base = { destination: trip.destination, checkedAt };
  const today = chinaDate(checkedAt);
  const inRange = validWeatherDate(trip.startDate) && trip.days.some(day => {
    const date = dateForDayIndex(trip.startDate, day.dayIndex) ?? '';
    return date >= today && Date.parse(date) - Date.parse(today) <= (WEATHER_FORECAST_DAYS - 1) * 86400_000;
  });
  if (!inRange) return { ...base, status: 'not_needed' };
  const { env, qweatherCredential } = await import('@rollinggo-trip/core/env');
  const auth = qweatherCredential();
  if (!env.qweatherApiHost || !auth) return { ...base, status: 'not_configured' };
  const forecast = await lookupQWeather(env.qweatherApiHost, auth, trip.destination);
  return forecast ? { ...base, status: 'available', forecast } : { ...base, status: 'unavailable' };
}

/** 查询指定城市的 15 天官方天气预报（无行程或跨城市自由查询） */
export async function getCityWeather(city: string): Promise<TripWeather> {
  const checkedAt = Date.now();
  const destination = city.trim();
  const base = { destination, checkedAt };
  if (!destination) return { ...base, status: 'unavailable' };
  const { env, qweatherCredential } = await import('@rollinggo-trip/core/env');
  const auth = qweatherCredential();
  if (!env.qweatherApiHost || !auth) return { ...base, status: 'not_configured' };
  const forecast = await lookupQWeather(env.qweatherApiHost, auth, destination);
  return forecast ? { ...base, status: 'available', forecast } : { ...base, status: 'unavailable' };
}

