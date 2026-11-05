import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { IdentityPlace } from '../lib/placeIdentity';
import { placeIdentity } from '../lib/placeIdentity';
import type { StoredImage } from '../lib/imageGallery';

const BindingSchema = Type.Object({
  imageKey: Type.String({ minLength: 1, maxLength: 200 }),
  inputHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  sourceSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  assignmentRevision: Type.Integer({ minimum: 1 }),
  entityId: Type.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false });
const PolicySchema = Type.Object({
  version: Type.Literal(1), mode: Type.Literal('reviewed'),
  entityId: Type.String({ minLength: 1, maxLength: 128 }),
  revision: Type.Integer({ minimum: 1 }),
  approved: Type.Array(BindingSchema, { maxItems: 10000 }),
}, { additionalProperties: false });
type ImageBinding = Static<typeof BindingSchema>;
type ImagePolicy = Static<typeof PolicySchema>;

function bindingKey(binding: ImageBinding): string {
  return JSON.stringify([binding.imageKey, binding.inputHash, binding.sourceSha256, binding.assignmentRevision, binding.entityId]);
}

function readPolicy(value: unknown): ImagePolicy | null {
  return Value.Check(PolicySchema, value) ? value : null;
}

/** 导入前校验；同实体同版本只允许收紧，不能用旧地点文件恢复已撤销图片。 */
export function validateImagePolicy(place: IdentityPlace, previous?: IdentityPlace): void {
  const raw = place.payload?.imageIdentity, oldRaw = previous?.payload?.imageIdentity;
  if (raw === undefined && oldRaw === undefined) return;
  const next = readPolicy(raw), before = readPolicy(oldRaw), identity = placeIdentity(place);
  if (!next || identity.version !== 2 || next.entityId !== place.id || next.revision !== identity.revision
    || next.approved.some(binding => binding.entityId !== place.id)
    || new Set(next.approved.map(binding => binding.imageKey)).size !== next.approved.length) {
    throw new Error(`图片归属契约无效或受控策略被移除：${place.name}`);
  }
  if (previous && oldRaw === undefined && placeIdentity(previous).version === 2
    && placeIdentity(previous).revision === next.revision) {
    throw new Error(`新增图片治理范围必须提高实体版本：${place.name}`);
  }
  if (before && next.revision === before.revision) {
    const approved = new Set(before.approved.map(bindingKey));
    if (next.approved.some(binding => !approved.has(bindingKey(binding)))) {
      throw new Error(`同版本图片归属不能新增或恢复已撤销图片：${place.name}`);
    }
  }
}

/** 没有有效逐图证据的旧清单、旧成员图库和异常策略均不能进入受控实体相册。 */
export function filterIdentityImages(place: IdentityPlace, images: readonly StoredImage[]): StoredImage[] {
  if (place.payload?.imageIdentity === undefined) return [...images];
  const policy = readPolicy(place.payload.imageIdentity);
  if (!policy || policy.entityId !== place.id || policy.revision !== placeIdentity(place).revision) return [];
  const approved = new Set(policy.approved.map(bindingKey));
  return images.filter(image => {
    const binding = image.provenance?.identityBinding;
    if (!Value.Check(BindingSchema, binding) || binding.entityId !== place.id || !approved.has(bindingKey(binding))
      || image.provenance?.sourceSha256 !== binding.sourceSha256) return false;
    const expectedHash = image.key.startsWith('xhs/photography/') ? image.provenance?.sha256 : binding.sourceSha256;
    return typeof expectedHash === 'string' && /^[a-f0-9]{64}$/.test(expectedHash) && image.key.endsWith(`/${expectedHash}.webp`);
  });
}
