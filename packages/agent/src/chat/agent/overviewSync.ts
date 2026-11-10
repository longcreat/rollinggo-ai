// 提交时把「新增活动」补进 overview 候选池。
//
// 为什么需要：详情弹窗/地图卡片的图片、简介、预约徽章都来自 `overview` 与活动的名称匹配
// （`matchOverview`）。生成链路由 add_candidate 写候选，但 Agent 的写工具只改 `days[].activities`，
// 于是 AI 新加的「都江堰景区」在详情里显示「暂无实景照片」，也没有概述与来源。
//
// 原则：只补缺，不覆盖。已有候选（调研产出的简介/预约/来源更可靠）原样保留。
import { MAX_OVERVIEW_POIS, uid, type ResearchPoi, type Trip } from '@rollinggo-trip/shared';
import type { PlacePointCache } from './placePoints';

/** 活动类目 → 候选池类目（只有美食/住宿有独立类目，其余按景点处理） */
const POI_CATEGORY: Record<string, ResearchPoi['category']> = { 美食: 'food', 住宿: 'hotel' };

/** 与前端 matchOverview 对齐：去空白、去括号分店后缀、小写 */
function keyOf(name: string): string {
  return name.replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, '').toLowerCase();
}

export function syncOverviewWithActivities(trip: Trip, points: PlacePointCache): Trip {
  const overview = [...(trip.overview ?? [])];
  const known = new Set(overview.map((poi) => keyOf(poi.name)));
  let added = false;

  for (const activity of trip.days.flatMap((day) => day.activities)) {
    const key = keyOf(activity.name);
    if (!key || known.has(key)) continue;
    if (overview.length >= MAX_OVERVIEW_POIS) break;
    const photos = points.findPhotos(activity.name).slice(0, 3).map((url) => ({ url }));
    overview.push({
      id: uid(),
      name: activity.name,
      category: POI_CATEGORY[activity.category] ?? 'attraction',
      // 弹窗里的「景点概览」直接用活动简介；空简介时保持空串，由前端决定展示
      intro: activity.description.slice(0, 200),
      reservation: 'unknown',
      ...(activity.openTime ? { openTime: activity.openTime.slice(0, 60) } : {}),
      ...(photos.length ? { coverUrl: photos[0]!.url, photos } : {}),
      sourceLinks: [],
    });
    known.add(key);
    added = true;
  }

  return added ? { ...trip, overview } : trip;
}
