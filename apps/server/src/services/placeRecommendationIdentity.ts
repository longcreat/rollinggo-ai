import { placeIdentity, type IdentityPlace } from '../lib/placeIdentity';

/** 显式采用已归一提及的分数；不借用 mentionSources 的全文/媒体治理语义。 */
export function validateRecommendationIdentity(place: IdentityPlace, previous?: IdentityPlace): void {
  const value = place.payload?.recommendationIdentity;
  const old = previous?.payload?.recommendationIdentity;
  if (value === undefined) {
    if (old !== undefined) throw new Error(`已治理推荐分不能撤回绑定：${place.name}`);
    return;
  }
  const identity = placeIdentity(place);
  const marker = value as Record<string, unknown> | null;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)
    || marker.version !== 1 || marker.policy !== 'resolved_attraction_mentions_v1'
    || identity.version !== 2 || marker.entityId !== place.id || identity.entityId !== place.id
    || marker.revision !== identity.revision || !Number.isInteger(marker.revision) || Number(marker.revision) < 1
    || typeof marker.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(marker.inputHash)
    || !['attraction', 'park', 'museum', 'scenic_area'].includes(String(place.payload?.xhsPlaceType))
    || !Number.isSafeInteger(marker.mentionCount) || Number(marker.mentionCount) < 0
    || typeof marker.recommendScore !== 'number' || !Number.isFinite(marker.recommendScore) || marker.recommendScore < 0
    || marker.mentionCount !== place.payload?.mentionCount || marker.recommendScore !== place.payload?.recommendScore) {
    throw new Error(`景点推荐分绑定无效：${place.name}`);
  }
  if (old && typeof old === 'object') {
    const before = old as Record<string, unknown>;
    if (before.inputHash === marker.inputHash
      && (before.recommendScore !== marker.recommendScore || before.mentionCount !== marker.mentionCount)) {
      throw new Error(`相同提及输入的推荐分冲突：${place.name}`);
    }
  }
}
