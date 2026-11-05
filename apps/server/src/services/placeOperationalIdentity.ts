import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { placeIdentity, type IdentityPlace } from '../lib/placeIdentity';
import { relationDigest } from './placeRelationIdentity';

const OperationalIdentity = Type.Object({
  version: Type.Literal(1), policy: Type.Literal('legacy_operational_preservation_v1'),
  entityId: Type.String({ minLength: 1, maxLength: 128 }),
  revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  sourceCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  payloadHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  sourceReview: Type.Literal('subject_only'), currentFactsReviewed: Type.Literal(false),
}, { additionalProperties: false });
const FIELDS = ['price', 'openHours', 'reservation', 'reservationNote', 'reservationEvidence', 'reservationConflict'];

/** 只接收同版本原运营资料保全声明；不能把它作为本轮现行事实核验。 */
export function validateOperationalIdentity(place: IdentityPlace): void {
  const value = place.payload?.operationalIdentity;
  if (value === undefined) return;
  const identity = placeIdentity(place);
  const payload = Object.fromEntries(FIELDS.filter(key => place.payload?.[key] !== undefined)
    .map(key => [key, place.payload![key]]));
  if (!Value.Check(OperationalIdentity, value) || identity.version !== 2
    || value.entityId !== place.id || identity.entityId !== place.id || value.revision !== identity.revision
    || !Array.isArray(place.payload?.mentionSources) || place.payload.mentionSources.length === 0
    || place.payload.identityWithdrawal !== undefined || relationDigest(payload) !== value.payloadHash) {
    throw new Error(`旧运营资料保全声明无效、主体版本或字段摘要不符：${place.name}`);
  }
}
