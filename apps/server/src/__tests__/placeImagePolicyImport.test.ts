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
import { createPlaceIdentityIndex } from '../lib/placeIdentity';
import { loadCityPlaceFacts, saveAmapPhoto } from '../generation/scheduling/placeFacts';

after(() => pool.end());

test('真实导入清除旧相册并拒绝旧清单复活，错名纠正保留旧ID而不恢复别名', async () => {
  const city = `逐图导入-${randomUUID()}`, root = randomUUID(), old = randomUUID();
  const folder = await mkdtemp(path.join(tmpdir(), 'place-image-policy-'));
  const placesFile = path.join(folder, 'xhs-places-scope.json');
  const imagesFile = path.join(folder, 'xhs-place-images-scope.json');
  const client = await pool.connect();
  const execute = (script: string, file: string) => promisify(execFile)(process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL(`../../scripts/${script}`, import.meta.url)), file],
    { env: process.env, windowsHide: true, timeout: 30000 });
  const readRoot = async () => (await client.query('SELECT payload FROM canonical_places WHERE id=$1', [root])).rows[0].payload;
  try {
    await client.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,payload,created_at)
      VALUES($1,$2,'呼归石公交站对面','文化','goldset',true,$3,now()),($4,$2,'呼归石公交站','文化','xhs',true,$3,now())`,
      [root, city, { coverImage: 'xhs/old/00.webp', imageGallery: [{ key: 'xhs/old/00.webp' }],
        mentionCount: 99, recommendScore: 999, typicalVisitMinutes: 180, themes: ['错误旧主题'] }, old]);
    const sha = 'a'.repeat(64);
    const binding = { imageKey: 'note_image:1', inputHash: 'b'.repeat(64), sourceSha256: sha, assignmentRevision: 1, entityId: root };
    const identity = { version: 2, revision: 2, entityId: root, canonicalName: '呼归石公交站对面', kind: 'same_entity',
      memberIds: [root, old], memberNames: ['呼归石公交站对面'] };
    const policy = { version: 1, mode: 'reviewed', entityId: root, revision: 2, approved: [binding] };
    const place = { id: root, name: '呼归石公交站对面', category: '文化', payload: { identity, imageIdentity: policy,
      mentionSources: [{ mentionId: 1, noteId: 1, inputHash: 'b'.repeat(64) }], mentionCount: 1, recommendScore: 3, themes: [] } };
    const savePlaces = () => writeFile(placesFile, JSON.stringify({ city, generatedAt: '2026-10-07', places: [place] }));
    await savePlaces();
    await execute('seed-xhs-places.ts', placesFile);
    assert.deepEqual((await readRoot()).imageGallery, []);
    assert.equal((await readRoot()).coverImage, null);
    assert.equal((await readRoot()).mentionCount, 1);
    assert.equal((await readRoot()).recommendScore, 3);
    assert.equal((await readRoot()).typicalVisitMinutes, undefined);
    assert.deepEqual((await readRoot()).themes, []);
    await saveAmapPhoto(city, place.name, 'https://store.is.autonavi.com/unreviewed.jpg');
    assert.equal((await readRoot()).amapPhoto, null);
    const facts = await loadCityPlaceFacts(city);
    assert.ok([...facts.values()].every(fact => !fact.coverImage && !fact.amapPhoto && !fact.visitMinutes));
    const rows = (await client.query('SELECT id,city,name,payload FROM canonical_places WHERE city=$1', [city])).rows;
    const index = createPlaceIdentityIndex(rows);
    assert.equal(index.resolve(city, '呼归石公交站对面', old).status, 'resolved');
    assert.equal(index.resolve(city, '呼归石公交站', old).status, 'unresolved');
    const legacy = { placeId: old, key: 'xhs/old/00.webp' };
    await writeFile(imagesFile, JSON.stringify({ city, images: [legacy] }));
    await execute('seed-xhs-place-images.ts', imagesFile);
    assert.deepEqual((await readRoot()).imageGallery, []);
    const approved = { placeId: root, key: `xhs/${root}/${sha}.webp`, sourceSha256: sha, identityBinding: binding };
    await writeFile(imagesFile, JSON.stringify({ city, images: [
      ...Array.from({ length: 4 }, (_, i) => ({ placeId: root, key: `xhs/legacy/${i}.webp` })), approved,
    ] }));
    await execute('seed-xhs-place-images.ts', imagesFile);
    assert.equal((await readRoot()).coverImage, approved.key);
    assert.equal((await readRoot()).imageGallery.length, 1);
    policy.approved = [];
    await savePlaces();
    await execute('seed-xhs-places.ts', placesFile);
    assert.equal((await readRoot()).coverImage, null);
    await execute('seed-xhs-place-images.ts', imagesFile);
    assert.deepEqual((await readRoot()).imageGallery, []);
    policy.approved = [binding];
    await savePlaces();
    await assert.rejects(execute('seed-xhs-places.ts', placesFile), /同版本图片归属/);
    policy.revision = identity.revision = 3;
    policy.approved = [{ ...binding, assignmentRevision: 2 }];
    await savePlaces();
    await execute('seed-xhs-places.ts', placesFile);
    await execute('seed-xhs-place-images.ts', imagesFile);
    assert.deepEqual((await readRoot()).imageGallery, []);
    approved.identityBinding = policy.approved[0]!;
    await writeFile(imagesFile, JSON.stringify({ city, images: [approved] }));
    await execute('seed-xhs-place-images.ts', imagesFile);
    assert.equal((await readRoot()).coverImage, approved.key);
  } finally {
    await client.query('DELETE FROM research_evidence WHERE city=$1', [city]);
    await client.query('DELETE FROM place_identity_imports WHERE city=$1', [city]);
    await client.query('DELETE FROM canonical_places WHERE city=$1', [city]);
    await client.query('DELETE FROM data_import WHERE city=$1', [city]);
    client.release();
    const resolved = path.resolve(folder);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('place-image-policy-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
