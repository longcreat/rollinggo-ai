import { chinaDate, dateForDayIndex, validWeatherDate, WEATHER_FORECAST_DAYS, type Trip, type TripWeather } from '@tripweaver/shared';
import { lookupQWeather } from '../integrations/qweather/weather';

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
  const { env, qweatherCredential } = await import('../env');
  const auth = qweatherCredential();
  if (!env.qweatherApiHost || !auth) return { ...base, status: 'not_configured' };
  const forecast = await lookupQWeather(env.qweatherApiHost, auth, trip.destination);
  return forecast ? { ...base, status: 'available', forecast } : { ...base, status: 'unavailable' };
}
