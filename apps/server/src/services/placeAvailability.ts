import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { placeIdentity, type IdentityPlace } from '../lib/placeIdentity';

const WithdrawalSchema = Type.Object({
  version: Type.Literal(1), revision: Type.Integer({ minimum: 1 }),
  reason: Type.Union([Type.Literal('split_source'), Type.Literal('unavailable_source')]),
  candidateIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 1000, uniqueItems: true }),
}, { additionalProperties: false });
export type IdentityWithdrawal = Static<typeof WithdrawalSchema>;

export function readWithdrawal(place: IdentityPlace): IdentityWithdrawal | null {
  const value = place.payload?.identityWithdrawal;
  return Value.Check(WithdrawalSchema, value) ? value : null;
}

/** 同版本允许撤回，不允许恢复或把历史候选扩成新的隐式归属。 */
export function validateWithdrawal(place: IdentityPlace & { verified?: boolean; lat?: number | null; lng?: number | null; evidence?: unknown[] }, previous?: IdentityPlace): void {
  const raw = place.payload?.identityWithdrawal, oldRaw = previous?.payload?.identityWithdrawal;
  const next = readWithdrawal(place), before = previous ? readWithdrawal(previous) : null;
  const identity = placeIdentity(place);
  const imagePolicy = place.payload?.imageIdentity;
  const noImages = imagePolicy && typeof imagePolicy === 'object' && !Array.isArray(imagePolicy)
    && Array.isArray((imagePolicy as Record<string, unknown>).approved)
    && ((imagePolicy as Record<string, unknown>).approved as unknown[]).length === 0;
  const allowedKeys = new Set(['identity', 'aliases', 'identityWithdrawal', 'imageIdentity', 'mentionSources',
    'themes', 'mentionCount', 'recommendScore']);
  const noFacts = Object.keys(place.payload ?? {}).every(key => allowedKeys.has(key))
    && (place.payload?.themes === undefined || (Array.isArray(place.payload.themes) && place.payload.themes.length === 0))
    && [place.payload?.mentionCount, place.payload?.recommendScore].every(value => value === undefined || value === 0)
    && place.lat == null && place.lng == null && (!place.evidence || place.evidence.length === 0);
  if (raw !== undefined && (!next || identity.version !== 2 || next.revision !== identity.revision
    || place.verified !== false || next.candidateIds.includes(place.id)
    || !noImages || !noFacts || !Array.isArray(place.payload?.mentionSources) || place.payload.mentionSources.length !== 0
    || (next.reason === 'unavailable_source' && next.candidateIds.length > 0))) {
    throw new Error(`实体撤回契约无效：${place.name}`);
  }
  if (identity.version === 2 && place.verified === false && !next) throw new Error(`停用实体缺少撤回声明：${place.name}`);
  if (oldRaw !== undefined && (!before || Number(identity.revision) <= before.revision)) {
    if (!next || !before || next.candidateIds.some(id => !before.candidateIds.includes(id))) {
      throw new Error(`旧版本不能恢复已撤回实体或扩大候选：${place.name}`);
    }
  }
  if (oldRaw !== undefined && !next && (!Array.isArray(place.payload?.mentionSources) || place.payload.mentionSources.length === 0)) {
    throw new Error(`恢复已撤回实体必须提供当前可用提及：${place.name}`);
  }
}
