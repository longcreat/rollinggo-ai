import { dateForDayIndex, lodgingLegsForDay, type GenerateForm, type Trip } from '@tripweaver/shared';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutes = (value: string) => TIME.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null;

/** 只报告实际可检查的范围；不编造时刻、门店、住宿往返或费用，不改变现有 gate。 */
export function assessCoverage(trip: Trip, form: GenerateForm) {
  const metrics: Record<string, number | null> = {};
  const limitations: string[] = [];
  const activities = trip.days.flatMap((day) => day.activities);
  let timed = 0, pairs = 0, timedPairs = 0, routedPairs = 0;
  for (const day of trip.days) {
    const prefix = `day.${day.dayIndex}.`;
    const spans = day.activities.map((a) => {
      const start = minutes(a.startTime), end = minutes(a.endTime);
      return start !== null && end !== null && end > start ? end - start : null;
    });
    const timedCount = spans.filter((v) => v !== null).length;
    timed += timedCount;
    const expected = Math.max(0, day.activities.length - 1);
    pairs += expected;
    let count = 0, travel = 0, distance = 0;
    for (let i = 0; i < expected; i++) {
      const from = day.activities[i]!, to = day.activities[i + 1]!;
      const leg = day.legs?.find((l) => l.fromActivityId === from.id && l.toActivityId === to.id);
      if (leg) { count++; travel += leg.durationMin; distance += leg.distanceM; }
      if (minutes(from.endTime) !== null && minutes(to.startTime) !== null) timedPairs++;
    }
    routedPairs += count;
    const lodging = lodgingLegsForDay(day);
    metrics[`${prefix}activities`] = day.activities.length;
    metrics[`${prefix}timedActivities`] = timedCount;
    metrics[`${prefix}activityMinutes`] = day.activities.length && timedCount === day.activities.length
      ? spans.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
    metrics[`${prefix}betweenActivityMinutes`] = expected > 0 && count === expected ? travel : null;
    metrics[`${prefix}betweenActivityKm`] = expected > 0 && count === expected ? distance / 1000 : null;
    metrics[`${prefix}lodgingMinutes`] = lodging.departure && lodging.returning
      ? lodging.departure.durationMin + lodging.returning.durationMin : null;
    if (!expected) limitations.push(`D${day.dayIndex} 只有 ${day.activities.length} 个活动，没有活动间路段；交通显示 —，不能据此认定全天交通为 0。`);
    else if (count < expected) limitations.push(`D${day.dayIndex} 仅记录 ${count}/${expected} 段活动间路线，无法统计完整路程。`);
  }
  metrics.activityCount = activities.length;
  metrics.timedActivityCount = timed;
  metrics.timeCoverageRatio = activities.length ? timed / activities.length : null;
  metrics.transferTimeCoverageRatio = pairs ? timedPairs / pairs : null;
  metrics.routePairCoverageRatio = pairs ? routedPairs / pairs : null;
  metrics.dateAvailable = dateForDayIndex(trip.startDate ?? '', 1) ? 1 : 0;
  metrics.openHoursCoverageRatio = activities.length ? activities.filter((a) => a.openTime?.trim()).length / activities.length : null;
  metrics.areaMealCount = activities.filter((a) => a.category === '美食' && /^(午餐|晚餐)｜/.test(a.name)
    && (a.name.endsWith('周边') || a.description?.startsWith('就近就餐的片区锚点'))).length;
  if (timed < activities.length) limitations.unshift(`当前生成按活动顺序排程，不要求具体起止时刻；${timed}/${activities.length} 项有时刻。时段冲突与全天时长仅在已有时刻上检查，不将未排时刻判成缺功能。`);
  if (!metrics.dateAvailable) limitations.push('未指定出发日期，按日期的闭馆检查不适用。');
  if (metrics.openHoursCoverageRatio !== null && metrics.openHoursCoverageRatio < 1) limitations.push('部分活动缺少营业/闭馆信息，日历检查不能证明所有地点开放。');
  if (!form.lodging?.trim() && !trip.lodging && !trip.days.some((day) => day.lodging)) {
    limitations.push('未指定住宿，住宿往返检查不适用；活动间交通不代表从住宿出发的全天交通。');
  } else if (trip.days.some((day) => metrics[`day.${day.dayIndex}.lodgingMinutes`] === null)) {
    limitations.push('已指定住宿但往返路线未完整记录，住宿往返为降级项。');
  }
  if (metrics.areaMealCount) limitations.push(`${metrics.areaMealCount} 餐按现有功能使用就餐区域；如有坐标，仅表示区域参考点，不承诺具体门店或实际步行距离。`);
  return { metrics, limitations };
}
