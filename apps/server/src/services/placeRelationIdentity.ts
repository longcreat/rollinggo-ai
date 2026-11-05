import { createHash } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { createPlaceIdentityIndex, isScopedPlace, placeIdentity, type IdentityPlace } from '../lib/placeIdentity';

const Id = Type.String({ minLength: 1, maxLength: 128 });
const Hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Offset = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Name = Type.String({ minLength: 1 });
const Entity = Type.Object({ entityId: Id, revision: Positive, canonicalName: Name,
  aliases: Type.Array(Name), status: Name, redirectTo: Type.Union([Id, Type.Null()]), managed: Type.Boolean(),
}, { additionalProperties: false });
const Mention = Type.Object({ mentionId: Positive, noteId: Positive, inputHash: Hash, textHash: Hash, textLength: Offset,
  entityId: Type.Union([Id, Type.Null()]), revision: Type.Union([Positive, Type.Null()]),
  status: Type.Union([Type.Literal('resolved'), Type.Literal('review'), Type.Literal('unresolved'), Type.Literal('excluded')]), reason: Name,
}, { additionalProperties: false });
const SourceState = Type.Object({ city: Name, algorithmVersion: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]), minMentions: Positive,
  surfaces: Type.Array(Name), entities: Type.Array(Entity), mentions: Type.Array(Mention),
  supplementalSources: Type.Optional(Type.Array(Type.Object({ scopePlaceId: Positive, inputHash: Hash, assignmentHash: Hash,
    kind: Type.Optional(Type.Literal('legacy_operational_preservation_v1')) },
    { additionalProperties: false }), { minItems: 1 })),
}, { additionalProperties: false });
const Manifest = Type.Object({ version: Type.Literal(1), revision: Positive, sourceHash: Hash, relationHash: Hash,
  sourceState: SourceState,
}, { additionalProperties: false });
const Endpoint = Type.Object({ entityId: Id, revision: Positive, start: Offset, end: Positive, surface: Name,
  mentions: Type.Array(Type.Object({ mentionId: Positive, inputHash: Hash }, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });
const Evidence = Type.Object({ noteId: Positive, textHash: Hash, from: Endpoint, to: Endpoint, quote: Name,
}, { additionalProperties: false });
const Relation = Type.Object({ from: Name, to: Name, fromEntityId: Id, toEntityId: Id,
  fromRevision: Positive, toRevision: Positive, strength: Type.Union([Type.Literal('direct'), Type.Literal('weak')]),
  noteCount: Positive, evidence: Type.Array(Evidence, { minItems: 1 }),
}, { additionalProperties: false });
const Relations = Type.Array(Relation);

export type RelationManifest = Static<typeof Manifest>;
export type BoundRelation = Static<typeof Relation>;
type BoundEndpoint = Static<typeof Endpoint>;

/** 与 Python digest 一致：键有序、UTF-8、无空白；契约数字只有安全整数。 */
export function relationDigest(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, ordered(item)]));
    return input;
  };
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}

export function validateRelationManifest(raw: unknown, city: string): RelationManifest {
  if (!Value.Check(Manifest, raw) || raw.sourceState.city !== city || relationDigest(raw.sourceState) !== raw.sourceHash) {
    throw new Error(`关系来源声明无效或摘要不符：${city}`);
  }
  const { entities, mentions } = raw.sourceState;
  const byEntity = new Map(entities.map(e => [e.entityId, e]));
  const byNote = new Map<number, string>();
  const supplemental = raw.sourceState.supplementalSources ?? [];
  if (new Set(supplemental.map(s => `${s.scopePlaceId}:${s.kind ?? 'text_warnings'}`)).size !== supplemental.length) {
    throw new Error(`关系来源声明包含重复补充文字范围：${city}`);
  }
  if (byEntity.size !== entities.length || new Set(mentions.map(m => m.mentionId)).size !== mentions.length) {
    throw new Error(`关系来源声明包含重复身份或提及：${city}`);
  }
  for (const mention of mentions) {
    const entity = mention.entityId ? byEntity.get(mention.entityId) : undefined;
    if ((mention.status === 'excluded') !== (mention.reason === 'reviewed_non_place')) {
      throw new Error(`关系来源声明的非地点排除理由无效：${city}`);
    }
    if (mention.status === 'resolved' ? !entity || entity.redirectTo !== null || entity.status !== 'ACTIVE'
      || mention.revision !== entity.revision : mention.entityId !== null || mention.revision !== null) {
      throw new Error(`关系来源声明的提及归属无效：${city}`);
    }
    const text = `${mention.textHash}:${mention.textLength}`;
    if (byNote.has(mention.noteId) && byNote.get(mention.noteId) !== text) throw new Error(`关系来源声明混入不同笔记版本：${city}`);
    byNote.set(mention.noteId, text);
  }
  return raw;
}

/** 全量校验后才允许写图；weak 也核对，不能通过过滤坏行使完整摘要失去意义。 */
export function validateBoundRelations(raw: unknown, manifest: RelationManifest): BoundRelation[] {
  if (!Value.Check(Relations, raw) || relationDigest(raw) !== manifest.relationHash) throw new Error('关系完整快照格式或摘要无效');
  const byEntity = new Map(manifest.sourceState.entities.map(e => [e.entityId, e]));
  const byMention = new Map(manifest.sourceState.mentions.map(m => [m.mentionId, m]));
  const pairs = new Set<string>();
  for (const relation of raw) {
    const pair = JSON.stringify([relation.fromEntityId, relation.toEntityId]);
    const from = byEntity.get(relation.fromEntityId), to = byEntity.get(relation.toEntityId);
    if (relation.fromEntityId >= relation.toEntityId || pairs.has(pair) || !from || !to
      || from.canonicalName !== relation.from || to.canonicalName !== relation.to
      || from.revision !== relation.fromRevision || to.revision !== relation.toRevision
      || from.redirectTo !== null || to.redirectTo !== null || from.status !== 'ACTIVE' || to.status !== 'ACTIVE') {
      throw new Error('关系端点不是当前独立实体或存在重复、自环');
    }
    pairs.add(pair);
    if (new Set(relation.evidence.map(e => e.noteId)).size !== relation.noteCount
      || relation.evidence.length !== relation.noteCount
      || relation.strength !== (relation.noteCount >= 2 ? 'direct' : 'weak')) throw new Error('关系支持篇数与逐篇证据不一致');
    for (const evidence of relation.evidence) {
      if (evidence.from.entityId !== relation.fromEntityId || evidence.to.entityId !== relation.toEntityId
        || evidence.from.revision !== relation.fromRevision || evidence.to.revision !== relation.toRevision) {
        throw new Error('关系逐篇端点与实体对不一致');
      }
      const begin = Math.min(evidence.from.start, evidence.to.start), end = Math.max(evidence.from.end, evidence.to.end);
      const quote = Array.from(evidence.quote); // 上游位置采用 Unicode 码点。
      if (quote.length !== end - begin || !(evidence.from.end <= evidence.to.start || evidence.to.end <= evidence.from.start)) {
        throw new Error('关系证据位置重叠或原文摘录长度不符');
      }
      for (const endpoint of [evidence.from, evidence.to]) {
        if (endpoint.start >= endpoint.end || quote.slice(endpoint.start - begin, endpoint.end - begin).join('') !== endpoint.surface
          || new Set(endpoint.mentions.map(m => m.mentionId)).size !== endpoint.mentions.length) throw new Error('关系端点原文位置或提及列表无效');
        for (const binding of endpoint.mentions) {
          const source = byMention.get(binding.mentionId);
          if (!source || source.status !== 'resolved' || source.entityId !== endpoint.entityId || source.revision !== endpoint.revision
            || source.inputHash !== binding.inputHash || source.noteId !== evidence.noteId || source.textHash !== evidence.textHash
            || endpoint.end > source.textLength) throw new Error('关系证据不属于当前提及、原文或实体版本');
        }
      }
    }
  }
  return raw;
}

/** 与地点导出共享声明，但不把普通 relationSources 当作受控事实替换指令。 */
export function validateRelationPlaces(manifest: RelationManifest, places: readonly IdentityPlace[]): void {
  const entities = new Map(manifest.sourceState.entities.map(e => [e.entityId, e]));
  for (const place of places) {
    const identity = placeIdentity(place), entity = entities.get(place.id);
    if (!entity || place.city !== manifest.sourceState.city || identity.version !== 2 || identity.entityId !== place.id
      || identity.revision !== entity.revision || identity.canonicalName !== entity.canonicalName || entity.redirectTo !== null) {
      throw new Error(`地点与关系来源声明不属于同一身份快照：${place.name}`);
    }
  }
}

/** 每次消费核对当前目录；缺地点、撤回、改版或受控提及失效均只排除相应边。 */
export function currentBoundRelations(manifest: RelationManifest, relations: readonly BoundRelation[],
  directory: readonly IdentityPlace[]): BoundRelation[] {
  const city = manifest.sourceState.city;
  const catalog = createPlaceIdentityIndex(directory);
  const entities = new Map(manifest.sourceState.entities.map(e => [e.entityId, e]));
  const resolvedPlaces = new Map<string, IdentityPlace | null>();
  const current = (endpoint: BoundEndpoint, name: string, noteId: number): boolean => {
    const key = JSON.stringify([endpoint.entityId, endpoint.revision, name]);
    if (!resolvedPlaces.has(key)) {
      const resolved = catalog.resolve(city, name, endpoint.entityId);
      const identity = resolved.status === 'resolved' ? placeIdentity(resolved.place) : {};
      resolvedPlaces.set(key, resolved.status === 'resolved' && resolved.canonicalPlaceId === endpoint.entityId
        && resolved.place.id === endpoint.entityId && identity.version === 2 && identity.entityId === endpoint.entityId
        && identity.revision === endpoint.revision ? resolved.place : null);
    }
    const place = resolvedPlaces.get(key);
    if (!place) return false;
    const controlled = entities.get(endpoint.entityId)?.managed || isScopedPlace(place);
    if (!controlled) return true;
    const sources = place.payload?.mentionSources;
    return Array.isArray(sources) && endpoint.mentions.every(binding => sources.some((source: unknown) =>
      source !== null && typeof source === 'object' && 'mentionId' in source && source.mentionId === binding.mentionId
      && 'noteId' in source && source.noteId === noteId && 'inputHash' in source && source.inputHash === binding.inputHash));
  };
  return relations.filter(relation => relation.strength === 'direct'
    && relation.evidence.every(e => current(e.from, relation.from, e.noteId) && current(e.to, relation.to, e.noteId)));
}
