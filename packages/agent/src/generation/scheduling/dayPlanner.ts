// 一天的时距排布：给已选好的点位分配到达/离开时刻，并检查通勤与闭馆。
//
// 只做「给定顺序 + 给定通勤时长」的时间推演，不选点、不算距离：
// 通勤时长由调用方注入（高德路径规划或启发式），模型永远不自己做算术。
// 返回 issues 而不抛错：排不下/闭馆是方案问题，由上层决定修补或重新组线。
import { dayDate, weekdayOf, type PlanPace } from '../planner/validator';
import { isClosedOnDate } from '@tripweaver/shared';
import { dwellMinutes, formatClock, parseClock, walkingMinutes } from '@tripweaver/services/itinerary/schedule';

export { dwellMinutes, formatClock, parseClock, walkingMinutes } from '@tripweaver/services/itinerary/schedule';

export interface PlanDayStop {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category?: string;
  openTime?: string;
}

export interface PlanDayInput {
  dayIndex: number;
  /** 行程起始日期；空串表示日期未知，跳过闭馆检查。 */
  startDate: string;
  /** 当天第一个活动的到达时刻，"HH:mm"。 */
  startAt: string;
  pace: PlanPace;
  stops: readonly PlanDayStop[];
  /** 相邻两点通勤分钟数；null 表示路线不可得，按步行估算兜底。 */
  travelMinutes(from: PlanDayStop, to: PlanDayStop): Promise<number | null>;
}

export interface TimedStop {
  id: string;
  name: string;
  arrive: string;
  leave: string;
  travelMin: number;
}

export interface PlanDayResult {
  timed: TimedStop[];
  endAt: string;
  totalTravelMin: number;
  /** 当日占用合计（停留 + 通勤），与 feasibility 的 hardDayTotalMin 同口径。 */
  totalMinutes: number;
  issues: string[];
}

const DAY_END_LIMIT = 21 * 60 + 30;
const MAX_TRAVEL_MIN = 120;

export async function planDay(input: PlanDayInput): Promise<PlanDayResult> {
  const issues: string[] = [];
  const start = parseClock(input.startAt) ?? 9 * 60;
  const date = dayDate(input.startDate, input.dayIndex);
  const timed: TimedStop[] = [];
  let clock = start;
  let totalTravelMin = 0;

  for (const [index, stop] of input.stops.entries()) {
    let travelMin = 0;
    if (index > 0) {
      const previous = input.stops[index - 1]!;
      const resolved = await input.travelMinutes(previous, stop);
      travelMin = resolved === null ? walkingMinutes(previous, stop) : Math.max(0, Math.round(resolved));
      if (resolved === null) issues.push(`${previous.name} → ${stop.name} 没有可用路线，按步行估算 ${travelMin} 分钟`);
      if (travelMin > MAX_TRAVEL_MIN) issues.push(`${previous.name} → ${stop.name} 通勤 ${travelMin} 分钟，过长`);
      clock += travelMin;
      totalTravelMin += travelMin;
    }
    const arrive = clock;
    const dwell = dwellMinutes(stop, input.pace);
    clock += dwell;
    timed.push({ id: stop.id, name: stop.name, arrive: formatClock(arrive), leave: formatClock(clock), travelMin });

    if (isClosedOnDate(stop.openTime, date)) {
      // 与 feasibility / validator 共用 isClosedOnDate：含「休息/不开放」与法定节假日豁免。
      // 它只在子句同时命中星期与闭馆词时返回真，所以这里的星期标签是准的。
      const weekday = weekdayOf(date);
      issues.push(`${stop.name} 在${weekday === null ? '' : weekdayLabel(weekday)}闭馆，当天到店会扑空`);
    }
  }

  if (clock > DAY_END_LIMIT) issues.push(`当天结束时刻 ${formatClock(clock)}，晚于 21:30，行程过满`);
  const dwellMin = timed.reduce((sum, item) => sum + Math.max(0, (parseClock(item.leave) ?? 0) - (parseClock(item.arrive) ?? 0)), 0);
  return { timed, endAt: formatClock(clock), totalTravelMin, totalMinutes: dwellMin + totalTravelMin, issues };
}

function weekdayLabel(weekday: number): string {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekday] ?? '';
}
