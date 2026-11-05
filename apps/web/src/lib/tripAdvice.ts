import { dateForDayIndex, personalAdviceIsCurrent, weatherForDate, WEATHER_FORECAST_DAYS, type PersonalAdviceItem, type ResearchPoi, type Trip, type TripWeather } from '@tripweaver/shared';

export interface TripAdvice { id: string; title: string; text: string; sources?: PersonalAdviceItem['sources'] }

export function buildTripAdvice(trip: Trip, weather: TripWeather | undefined, pois: Map<string, ResearchPoi>, now = Date.now()) {
  const suggestions: TripAdvice[] = [];
  const cautions: TripAdvice[] = [];
  const daily = trip.days.map(day => ({ day, weather: weatherForDate(weather, trip.destination, dateForDayIndex(trip.startDate, day.dayIndex), now) }));
  const forecasts = daily.flatMap(item => item.weather.status === 'available' ? [{ day: item.day, cast: item.weather.cast }] : []);
  const rainy = forecasts.filter(({ cast }) => /雨|雪/.test(cast.dayWeather + cast.nightWeather));
  if (rainy.length) suggestions.push({ id: 'rain', title: '雨雪准备', text: `第 ${rainy.map(item => item.day.dayIndex).join('、')} 天有雨雪预报，备雨具、防滑鞋和室内备选。` });
  if (forecasts.some(({ cast }) => Math.max(cast.dayTemp, cast.nightTemp) >= 30)) suggestions.push({ id: 'heat', title: '防晒补水', text: '部分日期达到30℃，注意防晒补水，午间休息。' });
  if (forecasts.some(({ cast }) => Math.min(cast.dayTemp, cast.nightTemp) <= 10 || Math.abs(cast.dayTemp - cast.nightTemp) >= 10)) suggestions.push({ id: 'layers', title: '备好外套', text: '有低温或较大温差，早晚添衣。' });
  suggestions.push({ id: 'transport', title: trip.transportMode === 'drive' ? '预留停车时间' : '预留路途时间', text: trip.transportMode === 'drive' ? '提前确认停车位置，预留找车位和步行时间。' : '确认公共交通运营时间，换乘和入场多留20–30分钟。' });
  if (trip.days.some(day => day.activities.length >= 5)) suggestions.push({ id: 'pace', title: '适当留白', text: '部分日期较满，优先游览最想去的两三站。' });
  if (!suggestions.some(item => item.id === 'rain' || item.id === 'heat' || item.id === 'layers')) suggestions.push({ id: 'packing', title: '随身物品', text: '带好证件、充电宝和饮水。' });

  const reservations = [...new Map([...pois.values()].filter(poi => poi.reservation === 'required').map(poi => [poi.id, poi])).values()];
  if (reservations.length) cautions.push({ id: 'reservations', title: '提前预约', text: `${reservations.map(poi => poi.name).join('、')}。预约及入场要求以官方为准。` });
  else cautions.push({ id: 'opening', title: '核实开放与预约', text: '出发前通过官方渠道确认闭馆日和预约要求。' });
  const severe = forecasts.filter(({ cast }) => /雷|暴雨|大雨|暴雪|大雪/.test(cast.dayWeather + cast.nightWeather)
    || [cast.dayPower, cast.nightPower].some(power => Math.max(...(power.match(/\d+/g) ?? ['0']).map(Number)) >= 5));
  if (severe.length) cautions.push({ id: 'severe', title: '大风雨雪提醒', text: `第 ${severe.map(item => item.day.dayIndex).join('、')} 天有较强风雨雪，留意当地预警，谨慎登高、临水。` });
  if (weather?.status === 'not_configured') cautions.push({ id: 'weather-unconfigured', title: '天气未接入', text: '出发前请自行查询目的地天气。' });
  else if (daily.some(item => item.weather.status === 'pending')) cautions.push({ id: 'forecast-window', title: '预报待更新', text: `和风天气预报覆盖当天及未来 ${WEATHER_FORECAST_DAYS} 天，临近出行再查看。` });
  else if (daily.some(item => item.weather.status === 'unavailable')) cautions.push({ id: 'weather-unavailable', title: '天气信息待补充', text: '部分预报获取失败，请稍后重试或自行查询。' });
  else if (daily.some(item => item.weather.status === 'undated')) cautions.push({ id: 'dates', title: '确认出行日期', text: '确定日期后查看天气、安排预约。' });
  for (const [index, note] of [...new Set(trip.meta.reviewNotes)].slice(0, 3).entries()) {
    if (note.trim()) cautions.push({ id: `review-${index}`, title: '行程提醒', text: note });
  }
  const saved = trip.meta.advice;
  const stale = Boolean(saved && !personalAdviceIsCurrent(trip));
  if (saved && !stale) {
    const mapItem = (kind: string) => (item: PersonalAdviceItem, index: number): TripAdvice => ({ ...item, id: `personal-${kind}-${index}` });
    // 强天气风险置顶；其余按专属内容、补充提醒排序，界面完整展示。
    return {
      suggestions: [...saved.suggestions.map(mapItem('suggestion')), ...suggestions.filter(item => ['rain', 'heat', 'layers'].includes(item.id))],
      cautions: [...cautions.filter(item => item.id === 'severe'), ...saved.cautions.map(mapItem('caution')), ...cautions.filter(item => !['severe', 'reservations', 'opening'].includes(item.id))],
      stale,
    };
  }
  return { suggestions: suggestions.slice(0, 4), cautions: [...cautions.filter(item => item.id === 'severe'), ...cautions.filter(item => item.id !== 'severe')], stale };
}
