import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/client';
import { loadPlaceRelations, resolveRelatedPairs } from '../generation/scheduling/placeRelations';
import { relatedPairKey } from '../generation/scheduling/schedule';
import { captureIdentityImport, recordIdentityImport, rollbackIdentityImport } from '../services/placeIdentityAudit';
import { currentBoundRelations, relationDigest, validateBoundRelations, validateRelationManifest,
  type BoundRelation, type RelationManifest } from '../services/placeRelationIdentity';
import type { IdentityPlace } from '../lib/placeIdentity';
import { acceptRelationSource, importRelationSnapshot } from '../services/placeRelationSnapshot';

after(() => pool.end());

function fixture(city = '逐提及关系单测') {
  const ids = ['a'.repeat(32), 'b'.repeat(32)];
  const names = ['咖啡（东店）', '乙园'];
  const text = '\n🧭同名咖啡→乙园';
  const textHash = relationDigest(['relation_text', text]);
  const mentions: RelationManifest['sourceState']['mentions'] = [1, 2].flatMap(noteId => ids.map((entityId, i) => ({
    mentionId: (noteId - 1) * 2 + i + 1, noteId, entityId, revision: i === 0 ? 2 : 1,
    inputHash: relationDigest([noteId, entityId]), textHash, textLength: Array.from(text).length,
    status: 'resolved', reason: i === 0 ? 'reviewed_assignment' : 'confirmed_name',
  })));
  const relations: BoundRelation[] = [{ from: names[0]!, to: names[1]!, fromEntityId: ids[0]!, toEntityId: ids[1]!,
    fromRevision: 2, toRevision: 1, strength: 'direct', noteCount: 2, evidence: [1, 2].map(noteId => ({
      noteId, textHash, quote: '同名咖啡→乙园',
      from: { entityId: ids[0]!, revision: 2, start: 2, end: 6, surface: '同名咖啡',
        mentions: [{ mentionId: noteId * 2 - 1, inputHash: mentions[noteId * 2 - 2]!.inputHash }] },
      to: { entityId: ids[1]!, revision: 1, start: 7, end: 9, surface: '乙园',
        mentions: [{ mentionId: noteId * 2, inputHash: mentions[noteId * 2 - 1]!.inputHash }] },
    })) }];
  const sourceState: RelationManifest['sourceState'] = { city, algorithmVersion: 1, minMentions: 2,
    surfaces: ['同名咖啡', ...names], mentions, entities: ids.map((entityId, i) => ({ entityId, revision: i === 0 ? 2 : 1,
      canonicalName: names[i]!, aliases: [], status: 'ACTIVE', redirectTo: null, managed: i === 0 })) };
  const manifest: RelationManifest = { version: 1, revision: 1, sourceHash: relationDigest(sourceState),
    relationHash: relationDigest(relations), sourceState };
  const places: IdentityPlace[] = ids.map((id, i) => ({ id, city, name: names[i]!, payload: {
    identity: { version: 2, entityId: id, revision: i === 0 ? 2 : 1, canonicalName: names[i], kind: 'same_entity',
      memberIds: [id], memberNames: [names[i]] },
    ...(i === 0 ? { mentionSources: mentions.filter(m => m.entityId === id).map(m => ({ mentionId: m.mentionId,
      inputHash: m.inputHash, noteId: m.noteId })) } : {}),
  } }));
  return { city, ids, names, manifest, relations, places };
}

test('逐篇双端点校验支持Unicode码点，强关系消费稳定ID，裸品牌不作为别名', () => {
  const f = fixture();
  assert.equal(validateRelationManifest(f.manifest, f.city), f.manifest);
  assert.equal(validateBoundRelations(f.relations, f.manifest), f.relations);
  assert.equal(currentBoundRelations(f.manifest, f.relations, f.places).length, 1);
  assert.equal(f.places[0]!.name.includes('同名'), false);
});

test('已知关系算法版本保留历史兼容，未知版本拒绝', () => {
  const f = fixture();
  for (const algorithmVersion of [1, 2, 3]) {
    const sourceState = { ...f.manifest.sourceState, algorithmVersion };
    const manifest = { ...f.manifest, sourceState, sourceHash: relationDigest(sourceState) };
    assert.equal(validateRelationManifest(manifest, f.city), manifest);
  }
  const sourceState = { ...f.manifest.sourceState, algorithmVersion: 4 };
  assert.throws(() => validateRelationManifest({ ...f.manifest, sourceState,
    sourceHash: relationDigest(sourceState) }, f.city), /关系来源声明/);
});

test('补充文字来源参与共同版本摘要但不产生关系端点，拒绝重复或非法散列', () => {
  const f = fixture();
  const supplemental = { scopePlaceId: 9, inputHash: 'a'.repeat(64), assignmentHash: 'b'.repeat(64) };
  const sourceState = { ...f.manifest.sourceState, supplementalSources: [supplemental] };
  const manifest = { ...f.manifest, sourceState, sourceHash: relationDigest(sourceState) };
  assert.equal(validateRelationManifest(manifest, f.city), manifest);
  assert.deepEqual(validateBoundRelations(f.relations, manifest), f.relations);
  for (const values of [[], [supplemental, supplemental], [{ ...supplemental, scopePlaceId: 0 }],
    [{ ...supplemental, inputHash: 'bad' }], [{ ...supplemental, unknown: true }]]) {
    const invalid = { ...sourceState, supplementalSources: values };
    assert.throws(() => validateRelationManifest({ ...manifest, sourceState: invalid,
      sourceHash: relationDigest(invalid) }, f.city), /关系来源声明/);
  }
  sourceState.supplementalSources[0]!.inputHash = 'c'.repeat(64);
  assert.throws(() => validateRelationManifest(manifest, f.city), /摘要不符/);
});

test('非地点提及可保留在来源声明，但不能作为关系证据或带实体归属', () => {
  const f = fixture();
  const mention = f.manifest.sourceState.mentions[0]!;
  mention.status = 'excluded'; mention.reason = 'reviewed_non_place';
  mention.entityId = null; mention.revision = null;
  f.manifest.sourceHash = relationDigest(f.manifest.sourceState);
  assert.equal(validateRelationManifest(f.manifest, f.city), f.manifest);
  assert.throws(() => validateBoundRelations(f.relations, f.manifest), /关系证据不属于/);
  for (const change of [{ entityId: f.ids[0]!, revision: 2 }, { reason: 'unassigned_target' }, { status: 'review' }]) {
    const invalid = structuredClone(f.manifest);
    Object.assign(invalid.sourceState.mentions[0]!, change);
    invalid.sourceHash = relationDigest(invalid.sourceState);
    assert.throws(() => validateRelationManifest(invalid, f.city), /关系来源声明/);
  }
});

test('同范围的运营保全与旧警示分别绑定，拒绝同类型重复及未知补充类型', () => {
  const f = fixture();
  const warning = { scopePlaceId: 9, inputHash: 'a'.repeat(64), assignmentHash: 'b'.repeat(64) };
  const operations = { ...warning, kind: 'legacy_operational_preservation_v1' };
  const sourceState = { ...f.manifest.sourceState, supplementalSources: [warning, operations] };
  const manifest = { ...f.manifest, sourceState, sourceHash: relationDigest(sourceState) };
  assert.equal(validateRelationManifest(manifest, f.city), manifest);
  assert.deepEqual(validateBoundRelations(f.relations, validateRelationManifest(manifest, f.city)), f.relations);
  for (const values of [[operations, operations], [warning, warning], [{ ...operations, kind: 'unknown' }],
    [{ ...operations, kind: null }], [{ ...operations, assignmentHash: 'bad' }]]) {
    const invalid = { ...sourceState, supplementalSources: values };
    assert.throws(() => validateRelationManifest({ ...manifest, sourceState: invalid,
      sourceHash: relationDigest(invalid) }, f.city), /关系来源声明/);
  }
  sourceState.supplementalSources[1]!.inputHash = 'c'.repeat(64);
  assert.throws(() => validateRelationManifest(manifest, f.city), /摘要不符/);
});

for (const change of ['hash', 'duplicate', 'note_text', 'unresolved_owner', 'wrong_city'] as const) {
  test(`来源声明拒绝 ${change}`, () => {
    const { city, manifest } = fixture();
    if (change === 'hash') manifest.sourceHash = '0'.repeat(64);
    if (change === 'duplicate') manifest.sourceState.mentions.push(manifest.sourceState.mentions[0]!);
    if (change === 'note_text') manifest.sourceState.mentions[0]!.textHash = '0'.repeat(64);
    if (change === 'unresolved_owner') manifest.sourceState.mentions[0]!.status = 'review';
    if (change === 'wrong_city') manifest.sourceState.city = '外城';
    if (change !== 'hash') manifest.sourceHash = relationDigest(manifest.sourceState);
    assert.throws(() => validateRelationManifest(manifest, city), /关系来源声明/);
  });
}

for (const change of ['old_hash', 'other_note', 'old_revision', 'overlap', 'wrong_surface', 'duplicate_note', 'weak', 'self_loop', 'swap', 'text_hash'] as const) {
  test(`完整关系图拒绝 ${change}`, () => {
    const { manifest, relations } = fixture();
    const edge = relations[0]!, proof = edge.evidence[0]!;
    if (change === 'old_hash') proof.from.mentions[0]!.inputHash = '0'.repeat(64);
    if (change === 'other_note') proof.noteId = 3;
    if (change === 'old_revision') proof.from.revision = 1;
    if (change === 'overlap') proof.to.start = 5;
    if (change === 'wrong_surface') proof.from.surface = '另一咖啡';
    if (change === 'duplicate_note') edge.evidence[1] = structuredClone(proof);
    if (change === 'weak') edge.strength = 'weak';
    if (change === 'self_loop') edge.toEntityId = edge.fromEntityId;
    if (change === 'swap') [proof.from, proof.to] = [proof.to, proof.from];
    if (change === 'text_hash') proof.textHash = '0'.repeat(64);
    manifest.relationHash = relationDigest(relations);
    assert.throws(() => validateBoundRelations(relations, manifest), /关系/);
  });
}

for (const change of ['withdrawn', 'redirect', 'revision', 'source', 'missing_source', 'city'] as const) {
  test(`消费时排除已变化端点 ${change}`, () => {
    const f = fixture(), place = f.places[0]!;
    if (change === 'withdrawn') place.payload!.identityWithdrawal = { candidateIds: [] };
    if (change === 'redirect') place.payload!.canonicalRedirectTo = f.ids[1];
    if (change === 'revision') (place.payload!.identity as Record<string, unknown>).revision = 3;
    if (change === 'source') (place.payload!.mentionSources as { inputHash: string }[])[0]!.inputHash = '0'.repeat(64);
    if (change === 'missing_source') delete place.payload!.mentionSources;
    if (change === 'city') place.city = '外城';
    assert.equal(currentBoundRelations(f.manifest, f.relations, f.places).length, 0);
  });
}

test('正式双导入、来源同实体版本变更、空图、旧文件与倒序审计回滚', async () => {
  const f = fixture(`关系双导入-${randomUUID()}`);
  // 全库ID唯一；测试固定ID只在这个SQL案例插入。
  const folder = await mkdtemp(path.join(tmpdir(), 'relation-identity-'));
  const placesFile = path.join(folder, 'xhs-places-relation.json'), relationsFile = path.join(folder, 'xhs-place-relations-identity.json');
  const client = await pool.connect();
  const execute = (script: string, file: string) => promisify(execFile)(process.execPath, ['--import', 'tsx',
    fileURLToPath(new URL(`../../scripts/${script}`, import.meta.url)), file], { env: process.env, windowsHide: true, timeout: 30000 });
  const writePlaces = async (value = f) => writeFile(placesFile, JSON.stringify({ city: value.city, generatedAt: '2026-10-07',
    relationIdentity: value.manifest, places: value.places.map(p => ({ ...p, category: '文化', lat: null, lng: null, verified: true, evidence: [] })) }));
  const writeRelations = async (value = f) => writeFile(relationsFile, JSON.stringify({ city: value.city,
    generatedAt: '2026-10-07', relationIdentity: value.manifest, relations: value.relations }));
  try {
    await client.query(`INSERT INTO place_relation(id,city,from_name,to_name,strength,note_count,created_at)
      VALUES($1,$2,$3,$4,'direct',2,now())`, [randomUUID(), f.city, ...f.names]);
    const initial = await captureIdentityImport(client, f.city);
    const oldAudit = await recordIdentityImport(client, f.city, 'legacy', initial);
    await client.query(`UPDATE place_identity_imports SET before_state=before_state-'relationSnapshots',
      after_state=after_state-'relationSnapshots' WHERE id=$1`, [oldAudit]);
    await writeRelations();
    await assert.rejects(execute('seed-xhs-relations.ts', relationsFile), /匹配已导入地点/);
    await writePlaces();
    await execute('seed-xhs-places.ts', placesFile);
    assert.equal((await loadPlaceRelations(f.city)).size, 0, '等待匹配关系时不能回退旧表');
    await assert.rejects(rollbackIdentityImport(client, oldAudit), /后续关系身份快照/);
    await execute('seed-xhs-relations.ts', relationsFile);
    const consumed = await loadPlaceRelations(f.city);
    assert.deepEqual(consumed.get(`id:${f.ids[0]}`), [`id:${f.ids[1]}`]);
    assert.deepEqual(resolveRelatedPairs(consumed, f.ids.map((canonicalPlaceId, i) => ({ name: `活动${i}`, canonicalPlaceId }))),
      new Set([relatedPairKey('活动0', '活动1')]));
    await writeFile(relationsFile, JSON.stringify({ city: f.city, relations: [] }));
    await assert.rejects(execute('seed-xhs-relations.ts', relationsFile), /旧关系文件/);
    await writeFile(placesFile, JSON.stringify({ city: f.city, places: [] }));
    await assert.rejects(execute('seed-xhs-places.ts', placesFile), /旧地点文件/);

    const partial = structuredClone(f);
    partial.places = partial.places.slice(0, 1);
    await writePlaces(partial);
    await execute('seed-xhs-places.ts', placesFile);
    assert.equal((await loadPlaceRelations(f.city)).size, 0, '此次未导出的地点不能借仍在库里的历史行恢复关系');
    await writePlaces(f);
    await execute('seed-xhs-places.ts', placesFile);
    assert.equal((await loadPlaceRelations(f.city)).size, 2);

    const changed = structuredClone(f);
    changed.manifest.revision++;
    changed.manifest.sourceState.algorithmVersion = 3;
    const newHash = relationDigest('新的原提及事实');
    changed.manifest.sourceState.mentions[0]!.inputHash = newHash;
    changed.relations[0]!.evidence[0]!.from.mentions[0]!.inputHash = newHash;
    (changed.places[0]!.payload!.mentionSources as { inputHash: string }[])[0]!.inputHash = newHash;
    changed.manifest.sourceHash = relationDigest(changed.manifest.sourceState);
    changed.manifest.relationHash = relationDigest(changed.relations);
    await writePlaces(changed);
    await execute('seed-xhs-places.ts', placesFile);
    assert.equal((await loadPlaceRelations(f.city)).size, 0);
    assert.equal((await client.query("SELECT 1 FROM data_import WHERE city=$1 AND source='xhs_relations'", [f.city])).rowCount, 0,
      '来源更新后不能继续声称旧关系文件已导入');
    await writeRelations(f);
    await assert.rejects(execute('seed-xhs-relations.ts', relationsFile), /匹配已导入地点/);
    await writeRelations(changed);
    await execute('seed-xhs-relations.ts', relationsFile);
    assert.equal((await loadPlaceRelations(f.city)).size, 2);

    const empty = structuredClone(changed);
    empty.manifest.revision++;
    empty.relations = [];
    for (const mention of empty.manifest.sourceState.mentions.filter(m => m.entityId === f.ids[0])) {
      mention.entityId = null; mention.revision = null; mention.status = 'review'; mention.reason = 'changed_input';
    }
    empty.manifest.sourceState.mentions[0]!.status = 'excluded';
    empty.manifest.sourceState.mentions[0]!.reason = 'reviewed_non_place';
    empty.places[0]!.payload!.mentionSources = [];
    empty.manifest.sourceHash = relationDigest(empty.manifest.sourceState);
    empty.manifest.relationHash = relationDigest(empty.relations);
    await writePlaces(empty);
    await execute('seed-xhs-places.ts', placesFile);
    await writeRelations(empty);
    await execute('seed-xhs-relations.ts', relationsFile);
    assert.equal((await loadPlaceRelations(f.city)).size, 0);
    assert.deepEqual((await client.query('SELECT relations FROM place_relation_snapshots WHERE city=$1', [f.city])).rows[0].relations, []);
    assert.equal((await client.query('SELECT manifest FROM place_relation_snapshots WHERE city=$1', [f.city]))
      .rows[0].manifest.sourceState.mentions[0].status, 'excluded');
    await writePlaces(changed);
    await assert.rejects(execute('seed-xhs-places.ts', placesFile), /版本回退/);
    const audits = (await client.query('SELECT id FROM place_identity_imports WHERE city=$1 AND id<>$2 ORDER BY created_at DESC', [f.city, oldAudit])).rows;
    assert.equal(audits.length, 8);
    await client.query('BEGIN');
    await assert.rejects(rollbackIdentityImport(client, audits.at(-1)!.id, true), /后续修改/);
    for (const audit of audits) await rollbackIdentityImport(client, audit.id, true);
    assert.deepEqual(await captureIdentityImport(client, f.city), initial);
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK');
    for (const table of ['place_identity_imports', 'place_relation_snapshots', 'place_relation', 'research_evidence', 'canonical_places', 'data_import']) {
      await client.query(`DELETE FROM ${table} WHERE city=$1`, [f.city]);
    }
    client.release();
    const resolved = path.resolve(folder);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('relation-identity-'));
    await rm(resolved, { recursive: true, force: true });
  }
});

test('关系导入等待城市锁后重验来源，不能跨过正在更新的快照', async () => {
  const f = fixture(`关系锁-${randomUUID()}`);
  const writer = await pool.connect(), importer = await pool.connect();
  try {
    await writer.query('BEGIN');
    await acceptRelationSource(writer, f.city, f.manifest, f.places);
    await writer.query('COMMIT');
    const next = structuredClone(f.manifest);
    next.revision++;
    next.relationHash = relationDigest([]);
    await writer.query('BEGIN');
    await acceptRelationSource(writer, f.city, next, f.places);
    const pid = (await importer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await importer.query('BEGIN');
    const blocked = assert.rejects(importRelationSnapshot(importer, f.city, f.manifest, f.relations), /当前来源快照/);
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      const status = await pool.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1', [pid]);
      if (status.rows[0]?.wait_event === 'advisory') { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    // 先释放锁再断言，测试失败也不会遗留永久等待的连接。
    await writer.query('COMMIT');
    await blocked;
    assert.equal(waiting, true);
    await importer.query('ROLLBACK');
    const stored = (await writer.query('SELECT manifest,relations FROM place_relation_snapshots WHERE city=$1', [f.city])).rows[0];
    assert.equal(stored.manifest.revision, 2);
    assert.equal(stored.relations, null);
  } finally {
    await writer.query('ROLLBACK');
    await importer.query('ROLLBACK');
    await writer.query('DELETE FROM place_relation_snapshots WHERE city=$1', [f.city]);
    writer.release(); importer.release();
  }
});
