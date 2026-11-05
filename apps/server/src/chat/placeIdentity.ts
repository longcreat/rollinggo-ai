/**
 * 编辑副本的「地点身份」绑定：把名字解析回库内实体（canonicalPlaceId）。
 *
 * 只在本次编辑的副本上做，历史快照保持原样（否则旧版本会因新别名规则而变动）。
 * 三种失败都是用户可修正的输入问题，直接 422 让对话层追问，而不是静默降级：
 * - ambiguous：同名多实体 → 要具体地址/分店
 * - withdrawn：实体已下架/待核实
 * - 未解析：留给后续 geocode 链，不在这里报错
 * `allowRevisit` 只在用户明确表达「再去」且没有被否定时才开。
 */
import { ACTIVITY_CATEGORIES, type Activity, type Trip } from '@tripweaver/shared';
import type { loadPlaceIdentityIndex } from '../services/placeIdentityService';
import type { ResolvedNewActivity } from './editOps';
import { placeCategory } from '../generation/retrievalRanking';

/** 只给本次编辑副本补身份；历史快照保留原样，模型的分类不能绕过实体重复校验。 */
export function bindEditPlaceIdentities(trip: Trip, drafts: ResolvedNewActivity[],
  identities: Awaited<ReturnType<typeof loadPlaceIdentityIndex>> | undefined, question: string): Trip {
  const current = structuredClone(trip);
  for (const activity of current.days.flatMap(day => day.activities)) {
    const resolved = identities?.resolve(trip.destination, activity.name, activity.canonicalPlaceId);
    if (resolved?.status === 'resolved') activity.canonicalPlaceId = resolved.canonicalPlaceId;
  }
  for (const draft of drafts) {
    if (draft.skipGeocode) continue;
    const resolution = identities?.resolve(trip.destination, draft.placeName ?? draft.name, draft.canonicalPlaceId);
    if (resolution?.status === 'ambiguous') throw Object.assign(new Error(`「${draft.name}」有多个同名地点，请补充具体地址或分店`), { statusCode: 422 });
    if (resolution?.status === 'unresolved' && resolution.reason === 'withdrawn') {
      throw Object.assign(new Error(`「${draft.name}」的具体归属待核实，请补充具体分店或选择其他已确认地点`), { statusCode: 422 });
    }
    if (resolution?.status === 'resolved') {
      draft.canonicalPlaceId = resolution.canonicalPlaceId;
      draft.placeName = resolution.place.name;
      const category = resolution.place.category;
      // 与排程保持一致：上游的「景点」及英文大类也覆盖模型分类。
      draft.category = (ACTIVITY_CATEGORIES as readonly string[]).includes(category)
        ? category as Activity['category']
        : placeCategory(category) === 'food' ? '美食' : placeCategory(category) === 'hotel' ? '住宿' : '文化';
      if (resolution.place.lat !== null && resolution.place.lng !== null) {
        draft.lat = resolution.place.lat; draft.lng = resolution.place.lng;
      }
    }
    draft.allowRevisit = /(?:再去|再逛|再次(?:去|游览)|重访)/.test(question)
      && !/(?:不|别|无需|避免).{0,5}(?:再去|再逛|再次|重访|重复)/.test(question);
  }
  return current;
}
