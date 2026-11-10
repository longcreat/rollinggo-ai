/**
 * 美食候选的筛选与排序（「推荐餐厅？」类提问的落地部分）。
 *
 * 硬约束，不靠模型自由发挥：
 * - 只收具名店铺（库内名字带「店/餐/馆」等，或高德 POI 类型命中餐饮）；书店/博物馆/商场不算
 * - 饮食要求（清淡/素食/清真）必须有文本证据，不能从「附近」推断
 * - 必须在某个未估算坐标的行程锚点 5km 内，否则不知道该排到哪天
 * - 同一店铺不重复（poiKey 哈希 + 80m 内同名合并）
 * 输出按到最近锚点的直线距离排序，只取 3 条。
 */
import { createHash } from 'node:crypto';
import { FoodCandidateSchema, haversineMeters, recommendedFoodPosition, uid, wgs84ToGcj02, type FoodCandidate, type Trip } from '@rollinggo-trip/shared';
import { Value } from '@sinclair/typebox/value';
import type { DetailSources } from '@rollinggo-trip/integrations/detailSources';
import type { DetailKnowledge } from './detailKnowledge';
import { renderOpenHours } from '../generation/scheduling/placeFacts';
import { asRecord } from '@rollinggo-trip/services/parse';

export async function searchFood(knowledge: DetailKnowledge, sources: DetailSources, trip: Trip, dayId: string | undefined, query: string, excluded: Set<string>, signal: AbortSignal, meal: FoodCandidate['meal'] = 'lunch') {
  const days = dayId ? trip.days.filter((d) => d.id === dayId) : trip.days;
  const anchors = days.flatMap((day) => day.activities.filter((a) => a.coordSource !== 'estimated' && (a.lat || a.lng)).map((activity) => ({ day, activity, point: activity.coordSystem === 'gcj02' ? activity : wgs84ToGcj02(activity.lat, activity.lng) })));
  const candidates: FoodCandidate[] = [];
  const notes: string[] = [];
  const add = (name: string, point: { lat: number; lng: number }, address: string, sources: FoodCandidate['sources'], cuisine?: string, openTime?: string, evidence = '') => {
    const facts = `${name} ${cuisine ?? ''} ${evidence}`;
    if (/书店|图书|博物馆|纪念馆|购物中心|商场/.test(name) && !/餐厅|饭店|咖啡|茶室|茶楼/.test(name)) return;
    // 不从“附近”推断饮食适用性；明确偏好必须有来源词证据，否则给无结果提示。
    if (/清淡|不辣/.test(query) && !/清淡|不辣|清蒸|粥|粤菜|素食/.test(facts)) return;
    if (/素食|纯素/.test(query) && !/素食|纯素|素斋/.test(facts)) return;
    if (/清真/.test(query) && !/清真/.test(facts)) return;
    const nearest = anchors.map((a) => ({ ...a, distance: haversineMeters(a.point, point) })).sort((a, b) => a.distance - b.distance)[0];
    const day = nearest?.day ?? days[0];
    if (!day || (nearest && nearest.distance > 5000)) return;
    const poiKey = createHash('sha256').update(`${name.trim()}|${point.lat.toFixed(4)}|${point.lng.toFixed(4)}`).digest('hex');
    if (excluded.has(poiKey) || candidates.some((c) => c.name === name && haversineMeters(c, point) < 80)) return;
    const candidate: FoodCandidate = {
      id: uid(), poiKey, tripId: trip.id, name: name.slice(0, 100), address: address.slice(0, 300), ...point,
      dayId: day.id, dayIndex: day.dayIndex, nearby: nearest?.activity.name ?? '',
      meal,
      reason: nearest ? `距离「${nearest.activity.name}」直线约 ${Math.round(nearest.distance)} 米，可结合第 ${day.dayIndex} 天路线选择；实际通行以路线为准。` : `位于${trip.destination}，可安排在第 ${day.dayIndex} 天；位置需自行确认。`,
      sources: sources.slice(0, 5), ...(cuisine ? { cuisine: cuisine.slice(0, 100) } : {}), ...(openTime ? { openTime: openTime.slice(0, 60) } : {}),
    };
    candidate.position = recommendedFoodPosition(trip, candidate);
    if (Value.Check(FoodCandidateSchema, candidate)) candidates.push(candidate);
  };
  const stored = knowledge.places;
  for (const place of stored) {
    const row = place;
    if (row.lat === null || row.lng === null || !Number.isFinite(row.lat) || !Number.isFinite(row.lng)) continue;
    // 库内只接收具名店铺，泛化菜名/街区不当成可添加餐厅。
    if (!/店|餐|馆|楼|饭|斋|坊|居|轩|咖啡|茶室/.test(row.name)) continue;
    const sources = place.evidence.filter((e) => e.sourceUrl && /^https?:\/\//.test(e.sourceUrl)).map((e) => ({ title: '地点资料', url: e.sourceUrl!.slice(0, 300) }));
    add(row.name, { lat: row.lat, lng: row.lng }, '', sources.length ? sources : [{ title: '已验证地点资料', url: '' }], undefined, renderOpenHours(asRecord(place.payload).openHours), place.evidence.map((e) => e.content).join(' '));
  }
  signal.throwIfAborted();
  // 库内候选不足 3 条时，退到高德 POI 搜索补位（类型命中餐饮才收）
  if (candidates.length < 3) {
    const keyword = /清淡/.test(query) ? '清淡 餐厅' : '餐厅';
    const hits = await sources.poi.searchPois('food', `${anchors[0]?.activity.name ?? ''} ${keyword}`, trip.destination, signal);
    for (const poi of hits) {
      if (!poi.location || !/餐|饭|食|菜|咖啡|茶|小吃|饮/.test(poi.type + poi.name)) continue;
      add(poi.name, poi.location, poi.address, [{ title: '高德地点搜索', url: 'https://lbs.amap.com/' }], poi.type, poi.opentime);
    }
  }
  signal.throwIfAborted();
  // 网页只补充参考依据，不能凭网页标题推断可直接添加的店铺坐标。
  // 已经花过搜索额度时直接复用本轮结果，不再重复查。
  const web = candidates.length < 3 && !sources.calls.search
    ? await sources.search.search(`${trip.destination} ${query} ${anchors[0]?.activity.name ?? ''}`.slice(0, 100)) : knowledge.web;
  signal.throwIfAborted();
  if (!candidates.length && /清淡|不辣|素食|纯素|清真/.test(query)) notes.push('暂未找到有资料支持这些饮食要求的具体店铺，可以换个区域查询；过敏原与食材需向店家确认。');
  const distance = (candidate: FoodCandidate) => Math.min(...anchors.map((a) => haversineMeters(a.point, candidate)));
  return { candidates: candidates.sort((a, b) => distance(a) - distance(b)).slice(0, 3), notes, web };
}
