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
import { validateRecommendationIdentity } from '../services/placeRecommendationIdentity';

after(() => pool.end());

function fixture(id: string) {
  const identity = { version: 2, entityId: id, revision: 2, canonicalName: '测试公园',
    memberIds: [id], memberNames: ['测试公园'], kind: 'same_entity' };
  return { id, city: '测试', name: '测试公园', payload: {
    identity, xhsPlaceType: 'attraction', mentionCount: 2, recommendScore: 7,
    recommendationIdentity: { version: 1, policy: 'resolved_attraction_mentions_v1',
      entityId: id, revision: 2, inputHash: 'a'.repeat(64), mentionCount: 2, recommendScore: 7 },
  } };
}

test('分数绑定拒绝跨实体、旧版本、非景点、损坏分数、移除绑定和同输入冲突', () => {
  const place = fixture('root');
  validateRecommendationIdentity(place);
  for (const change of [{ entityId: 'other' }, { revision: 1 }, { inputHash: 'bad' },
    { mentionCount: -1 }, { recommendScore: NaN }, { recommendScore: 9 }]) {
    const bad = structuredClone(place);
    Object.assign(bad.payload.recommendationIdentity, change);
    assert.throws(() => validateRecommendationIdentity(bad), /绑定无效/);
  }
  const food = structuredClone(place); food.payload.xhsPlaceType = 'food';
  assert.throws(() => validateRecommendationIdentity(food), /绑定无效/);
  const unbound = { ...place, payload: { identity: place.payload.identity } };
  assert.throws(() => validateRecommendationIdentity(unbound, place), /不能撤回绑定/);
  const changed = structuredClone(place);
  changed.payload.recommendScore = changed.payload.recommendationIdentity.recommendScore = 8;
  assert.throws(() => validateRecommendationIdentity(changed, place), /相同提及输入/);
  changed.payload.recommendationIdentity.inputHash = 'b'.repeat(64);
  validateRecommendationIdentity(changed, place);
});

test('真实导入同时修正 xhs 和 goldset 旧高分，重复导入稳定，旧导出不能复活旧分', async () => {
  const city = `推荐分导入-${randomUUID()}`;
  const ids = [randomUUID(), randomUUID()];
  const folder = await mkdtemp(path.join(tmpdir(), 'place-recommendation-'));
  const file = path.join(folder, 'xhs-places-score.json');
  const execute = () => promisify(execFile)(process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('../../scripts/seed-xhs-places.ts', import.meta.url)), file],
    { env: process.env, windowsHide: true, timeout: 30000 });
  const profile = { profileVersion: 1, intro: '已保留的简介', highlights: [] };
  const gallery = [{ key: 'xhs/retained/00.webp' }];
  const read = () => pool.query('SELECT id,source,payload FROM canonical_places WHERE city=$1 ORDER BY id', [city]);
  try {
    for (let i = 0; i < ids.length; i++) await pool.query(`INSERT INTO canonical_places
      (id,city,name,category,source,verified,payload,created_at) VALUES($1,$2,$3,'自然',$4,true,$5,now())`,
    [ids[i], city, `测试公园${i}`, i ? 'goldset' : 'xhs', {
      recommendScore: 999, mentionCount: 99, typicalVisitMinutes: 80, themes: ['园林'], tips: ['原提示'],
      content: profile, imageGallery: gallery, coverImage: gallery[0]!.key,
    }]);
    const places = ids.map((id, i) => {
      const place = fixture(id); place.name += i;
      place.payload.identity.canonicalName = place.name;
      place.payload.identity.memberNames = [place.name];
      return { ...place, category: '自然', payload: { ...place.payload, content: profile,
        typicalVisitMinutes: 80, themes: ['园林'], tips: ['原提示'] } };
    });
    const save = (items: unknown[]) => writeFile(file, JSON.stringify({ city, generatedAt: '2026-10-09', places: items }));
    await save(places); await execute();
    const first = (await read()).rows;
    for (const row of first) {
      assert.equal(row.payload.recommendScore, 7); assert.equal(row.payload.mentionCount, 2);
      assert.deepEqual(row.payload.content, profile); assert.deepEqual(row.payload.imageGallery, gallery);
      assert.equal(row.payload.typicalVisitMinutes, 80); assert.deepEqual(row.payload.themes, ['园林']);
      assert.deepEqual(row.payload.tips, ['原提示']); assert.equal(row.payload.mentionSources, undefined);
    }
    await execute(); assert.deepEqual((await read()).rows, first);
    const old = structuredClone(places) as Array<{payload: Record<string, unknown>}>;
    for (const place of old) { delete place.payload.recommendationIdentity; place.payload.recommendScore = 999; }
    await save(old); await assert.rejects(execute(), /不能撤回绑定/);
    assert.deepEqual((await read()).rows, first);
    places[0]!.payload.identity.revision = places[0]!.payload.recommendationIdentity.revision = 1;
    await save(places); await assert.rejects(execute(), /实体身份版本回退/);
    assert.deepEqual((await read()).rows, first);
    const audits = await pool.query('SELECT count(*)::int n FROM place_identity_imports WHERE city=$1', [city]);
    assert.equal(audits.rows[0].n, 2);
  } finally {
    for (const table of ['research_evidence', 'place_identity_imports', 'canonical_places', 'data_import'])
      await pool.query(`DELETE FROM ${table} WHERE city=$1`, [city]);
    const resolved = path.resolve(folder);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('place-recommendation-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
