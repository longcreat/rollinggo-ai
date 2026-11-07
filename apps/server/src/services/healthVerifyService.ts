// 体检卡实时核验（H2）：按 finding 查最新信息（预约/营业时间），直连 DetailSources，
// 不走 durable 子代理——单点查询走子代理是杀鸡用牛刀，且这是同步 REST 语义。
import { simulateTrip, type HealthFinding, type Trip } from '@tripweaver/shared';
import { resolveDetailSources } from '../chat/detailSources';
import { getTripWeather } from './tripWeatherService';

const VERIFY_TIMEOUT_MS = 15_000;

/** 找到 finding 定位的活动名（决定核验关键词） */
function findingTarget(trip: Trip, finding: HealthFinding): { name: string; dayDate?: string } | null {
  const day = trip.days.find((d) => d.dayIndex === finding.dayIndex);
  if (!day) return null;
  const activity = finding.activityId
    ? day.activities.find((a) => a.id === finding.activityId)
    : day.activities[0];
  if (!activity) return null;
  return { name: activity.name };
}

/**
 * 单条核验：预约政策（web_search）+ 最新营业时间（POI 搜索）+ 天气窗口。
 * 返回给人看的核验文本；查不到如实说，不编造。
 */
export async function verifyFinding(options: {
  userId: string;
  trip: Trip;
  finding: HealthFinding;
}): Promise<{ text: string; checkedAt: number }> {
  const { userId, trip, finding } = options;
  const target = findingTarget(trip, finding);
  const signal = AbortSignal.timeout(VERIFY_TIMEOUT_MS);
  const sources = await resolveDetailSources(userId, signal, true);
  const parts: string[] = [];

  if (target) {
    // 营业时间/闭馆核验：POI 搜索（命中高德）
    const pois = await sources.poi.searchPois('attraction', target.name, trip.destination, signal).catch(() => []);
    if (pois.length) {
      const first = pois[0]!;
      if (first.opentime) parts.push(`高德最新营业时间：${first.opentime}`);
      if (first.rating) parts.push(`评分 ${first.rating}`);
    }
    // 预约政策核验：web_search
    const hits = await sources.search.search(`${trip.destination} ${target.name} 预约 门票 政策`.slice(0, 100)).catch(() => []);
    if (hits.length) {
      parts.push(`网上攻略：${hits[0]!.title}${hits[0]!.summary ? ` — ${hits[0]!.summary.slice(0, 150)}` : ''}`);
    }
  }

  // 天气窗口（行程在预报期内才有意义）：TripWeather.forecast.casts
  if (trip.startDate) {
    const weather = await getTripWeather(trip).catch(() => null);
    const casts = weather?.forecast?.casts ?? [];
    const risky = casts.filter((cast) => /雨|雪|大风|高温/i.test(`${cast.dayWeather}${cast.nightWeather}`));
    if (risky.length) {
      parts.push(`天气提醒：${risky.map((cast) => `${cast.date} ${cast.dayWeather}`).join('；')}`);
    }
  }

  sources.assertHealthy();
  const text = parts.length
    ? parts.join('\n')
    : '暂未查到补充信息（可能搜索未配置或无结果），请出发前自行核实预约与开放时间';
  return { text: text.slice(0, 400), checkedAt: Date.now() };
}
