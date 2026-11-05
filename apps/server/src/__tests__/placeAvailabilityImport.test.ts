import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSampleTrip } from '@tripweaver/shared';
import { pool } from '../db/client';
import { prepareImportedPlaces, type ImportPlace } from '../services/placeImportIdentity';
import { captureIdentityImport, rollbackIdentityImport } from '../services/placeIdentityAudit';
import { loadPlaceIdentityIndex } from '../services/placeIdentityService';
import { createPlaceRetriever } from '../generation/placeRetrieval';
import { loadCityPlaceFacts } from '../generation/scheduling/placeFacts';
import { createTrip, getTrip } from '../services/tripService';
import { bindEditPlaceIdentities } from '../chat/placeIdentity';
import { applyItineraryEdits, editActivityDrafts, normalizeEditOps } from '../chat/editOps';

after(() => pool.end());

function active(id: string, name: string, revision: number): ImportPlace {
  return { id, name, category: '美食', verified: true, lat: 36.6, lng: 117, payload: {
    identity: { version: 2, revision, entityId: id, canonicalName: name, kind: 'same_entity', memberIds: [id], memberNames: [name] },
    imageIdentity: { version: 1, mode: 'reviewed', revision, entityId: id, approved: [] },
    mentionSources: [{ mentionId: 1, noteId: 1, inputHash: 'b'.repeat(64) }], themes: [], mentionCount: 1, recommendScore: 3,
  } };
}
function withdraw(place: ImportPlace, candidateIds: string[]): ImportPlace {
  return { ...place, verified: false, lat: null, lng: null, payload: { ...place.payload, mentionSources: [], mentionCount: 0, recommendScore: 0,
    identityWithdrawal: { version: 1, revision: (place.payload!.identity as Record<string, unknown>).revision,
      reason: candidateIds.length ? 'split_source' : 'unavailable_source', candidateIds } } };
}

test('真实撤回导入清事实图片向量，旧文件不能复活；历史行程保留且倒序回滚恢复原行', async () => {
  const city = `撤回-${randomUUID()}`, user = randomUUID();
  const old = active(randomUUID(), '老周家牛肉烧饼', 2);
  const branches = [active(randomUUID(), '老周家牛肉烧饼（普利街店）', 2), active(randomUUID(), '老周家牛肉烧饼（洪楼店）', 2)];
  const folder = await mkdtemp(path.join(tmpdir(), 'place-withdrawal-'));
  const placesFile = path.join(folder, 'xhs-places-withdrawal.json'), imagesFile = path.join(folder, 'xhs-place-images-withdrawal.json');
  const client = await pool.connect();
  const execute = (script: string, file: string) => promisify(execFile)(process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL(`../../scripts/${script}`, import.meta.url)), file],
    { env: process.env, windowsHide: true, timeout: 30000 });
  const importPlaces = async (places: ImportPlace[]) => {
    await writeFile(placesFile, JSON.stringify({ city, generatedAt: '2026-10-07', places }));
    return execute('seed-xhs-places.ts', placesFile);
  };
  const read = async () => (await client.query('SELECT verified,source,lat,lng,payload,embedding FROM canonical_places WHERE id=$1', [old.id])).rows[0];
  try {
    const initial = active(old.id, old.name, 1);
    await client.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,lat,lng,payload,embedding,created_at)
      VALUES($1,$2,$3,'美食','goldset',true,36.6,117,$4,$5::vector,now())`, [old.id, city, old.name,
      { ...initial.payload, content: { intro: '两家混合旧介绍' }, typicalVisitMinutes: 180, themes: ['旧主题'], mentionCount: 99,
        recommendScore: 999, coverImage: 'xhs/old/00.webp', imageGallery: [{ key: 'xhs/old/00.webp' }],
        amapPhoto: 'https://example.test/old.jpg', embeddedText: '旧向量' }, JSON.stringify(Array(1024).fill(0.01))]);
    await client.query(`INSERT INTO research_evidence(id,place_id,city,kind,strength,content,source_url,fetched_at)
      VALUES($1,$2,$3,'xhs_reason','weak','旧混合事实','https://example.test/note',now())`, [randomUUID(), old.id, city]);
    await client.query("INSERT INTO users(id,email,password_hash,created_at) VALUES($1,$2,'',now())", [user, `${user}@example.test`]);
    const trip = makeSampleTrip(); trip.destination = city;
    Object.assign(trip.days[0]!.activities[0]!, { name: old.name, canonicalPlaceId: old.id });
    const saved = await createTrip(user, trip);
    const before = await captureIdentityImport(client, city);
    const retired = withdraw(old, branches.map(p => p.id));
    await importPlaces([retired, ...branches]);
    const row = await read();
    assert.equal(row.verified, false); assert.equal(row.source, 'goldset');
    assert.equal(row.lat, null); assert.equal(row.lng, null); assert.equal(row.embedding, null);
    assert.equal(row.payload.embeddedText, undefined); assert.equal(row.payload.content, undefined);
    assert.equal(row.payload.typicalVisitMinutes, undefined); assert.equal(row.payload.coverImage, null);
    assert.equal(row.payload.amapPhoto, null); assert.deepEqual(row.payload.imageGallery, []);
    assert.equal(row.payload.mentionCount, 0); assert.equal(row.payload.recommendScore, 0);
    assert.equal((await client.query('SELECT count(*)::int n FROM research_evidence WHERE place_id=$1', [old.id])).rows[0].n, 0);
    const retrieve = createPlaceRetriever({ query: (sql, values) => client.query(sql, values), embed: async () => null });
    assert.deepEqual(new Set((await retrieve([], { city, browse: true, vector: 'off' })).map(p => p.id)), new Set(branches.map(p => p.id)));
    assert.equal((await loadCityPlaceFacts(city)).has(old.name), false);
    let index = await loadPlaceIdentityIndex(city);
    assert.equal(index.resolve(city, old.name, old.id).status, 'ambiguous');
    for (const branch of branches) assert.equal(index.resolve(city, branch.name, branch.id).status, 'resolved');
    assert.deepEqual(await getTrip(user, saved.id), saved);
    const ops = normalizeEditOps(branches.map(branch => ({ kind: 'add_activity', dayIndex: 1, activity: { name: branch.name, category: '美食' } })));
    const current = bindEditPlaceIdentities(saved, editActivityDrafts(ops), index, '添加两家分店');
    assert.equal(current.days[0]!.activities[0]!.canonicalPlaceId, old.id);
    const edited = applyItineraryEdits(current, ops); assert.equal(edited.changed, true);
    const next = await createTrip(user, edited.trip, saved.id);
    assert.deepEqual(await getTrip(user, saved.id), saved);
    const reread = await getTrip(user, next.id);
    for (const id of [old.id, ...branches.map(p => p.id)]) assert.ok(reread!.days.flatMap(day => day.activities).some(a => a.canonicalPlaceId === id));
    assert.throws(() => bindEditPlaceIdentities(saved, editActivityDrafts(normalizeEditOps([
      { kind: 'add_activity', dayIndex: 1, activity: { name: old.name } },
    ])), index, ''), /多个同名/);
    await writeFile(imagesFile, JSON.stringify({ city, images: [{ placeId: old.id, key: 'xhs/old/00.webp' }] }));
    await execute('seed-xhs-place-images.ts', imagesFile);
    assert.deepEqual((await read()).payload.imageGallery, []);
    await assert.rejects(importPlaces([old]), /旧版本不能恢复/);
    await importPlaces([{ id: old.id, name: old.name }]);
    assert.equal((await read()).verified, false, '无版本旧文件被跳过');
    await importPlaces([withdraw(old, [branches[0]!.id])]);
    index = await loadPlaceIdentityIndex(city);
    assert.equal(index.resolve(city, old.name, old.id).status, 'ambiguous', '单店也不能替换旧ID');
    await assert.rejects(importPlaces([retired]), /扩大候选/);
    await importPlaces([active(old.id, old.name, 3)]);
    assert.equal((await read()).verified, true);
    await importPlaces([withdraw(active(old.id, old.name, 3), [])]);
    assert.equal((await loadPlaceIdentityIndex(city)).resolve(city, old.name, old.id).status, 'unresolved');
    const audits = (await client.query('SELECT id FROM place_identity_imports WHERE city=$1 ORDER BY created_at DESC', [city])).rows;
    assert.ok(audits.length >= 4);
    await client.query('BEGIN');
    await assert.rejects(rollbackIdentityImport(client, audits.at(-1)!.id, true), /后续修改/);
    for (const audit of audits) await rollbackIdentityImport(client, audit.id, true);
    assert.deepEqual(await captureIdentityImport(client, city), before);
    await client.query('COMMIT');
    assert.deepEqual(await getTrip(user, saved.id), saved);
  } finally {
    await client.query('ROLLBACK');
    await client.query('DELETE FROM trips WHERE user_id=$1', [user]);
    await client.query('DELETE FROM users WHERE id=$1', [user]);
    await client.query('DELETE FROM research_evidence WHERE city=$1', [city]);
    await client.query('DELETE FROM place_identity_imports WHERE city=$1', [city]);
    await client.query('DELETE FROM canonical_places WHERE city=$1', [city]);
    await client.query('DELETE FROM data_import WHERE city=$1', [city]);
    client.release();
    const resolved = path.resolve(folder);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('place-withdrawal-'));
    await rm(resolved, { recursive: true, force: true });
  }
});

test('撤回候选跨城、自指、同批被合并和被过滤的旧输入均拒绝', async () => {
  const city = `候选-${randomUUID()}`, old = active(randomUUID(), '泛名', 2);
  const a = active(randomUUID(), '甲店', 2), b = active(randomUUID(), '乙店', 2);
  const client = await pool.connect(); await client.query('BEGIN');
  try {
    await client.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,payload,created_at)
      VALUES($1,$2,$3,'美食','xhs',true,$4,now()),($5,$6,$7,'美食','xhs',true,$8,now())`,
      [a.id, city, a.name, { ...a.payload, canonicalRedirectTo: b.id }, b.id, `${city}-别城`, b.name, b.payload]);
    await assert.rejects(prepareImportedPlaces(client, city, [withdraw(old, [b.id])]), /同城有效/);
    await assert.rejects(prepareImportedPlaces(client, city, [withdraw(old, [old.id])]), /撤回契约无效/);
    await assert.rejects(prepareImportedPlaces(client, city, [withdraw(old, [a.id]), a]), /同城有效/);
    const newA = active(randomUUID(), '新甲店', 2), root = active(randomUUID(), '合并主店', 2);
    root.payload!.identity = { ...(root.payload!.identity as object), memberIds: [root.id, newA.id] };
    await client.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,payload,created_at)
      VALUES($1,$2,$3,'美食','xhs',true,$4,now())`, [newA.id, city, newA.name, newA.payload]);
    await assert.rejects(prepareImportedPlaces(client, city, [withdraw(old, [newA.id]), root]), /同城有效/);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
