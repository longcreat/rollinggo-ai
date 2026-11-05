import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/client';
import { prepareImportedPlaces, reconcileImportedPlaces } from '../services/placeImportIdentity';
import { relationDigest } from '../services/placeRelationIdentity';
import { validateOperationalIdentity } from '../services/placeOperationalIdentity';
import type { IdentityPlace } from '../lib/placeIdentity';

after(() => pool.end());

function fixture(): IdentityPlace {
  const id = randomUUID();
  const facts = { price: '旧票价免费', openHours: { status: 'unknown' }, reservation: 'unknown' };
  return { id, city: '运营保全单测', name: '旧园', payload: { ...facts,
    identity: { version: 2, entityId: id, canonicalName: '旧园', revision: 2, kind: 'same_entity',
      memberIds: [id], memberNames: ['旧园'] },
    mentionSources: [{ mentionId: 1, noteId: 2, inputHash: 'a'.repeat(64) }],
    operationalIdentity: { version: 1, policy: 'legacy_operational_preservation_v1', entityId: id,
      revision: 2, sourceCount: 1, payloadHash: relationDigest(facts), sourceReview: 'subject_only', currentFactsReviewed: false },
  } };
}

test('运营保全只接受原主体版本及完整旧字段摘要，不能升级为现行事实审核', () => {
  const place = fixture();
  assert.doesNotThrow(() => validateOperationalIdentity(place));
  for (const change of [{ version: 2 }, { policy: 'other' }, { entityId: 'other' }, { revision: 1 },
    { sourceCount: 0 }, { payloadHash: 'a'.repeat(64) }, { sourceReview: 'full' },
    { currentFactsReviewed: true }, { unknown: true }]) {
    const changed = structuredClone(place);
    Object.assign(changed.payload!.operationalIdentity as object, change);
    assert.throws(() => validateOperationalIdentity(changed), /旧运营资料保全声明/);
  }
  for (const change of [{ price: '新价' }, { reservationNote: '新增预约' }, { mentionSources: [] },
    { identity: undefined }, { identityWithdrawal: {} }, { operationalIdentity: null }]) {
    const changed = structuredClone(place);
    Object.assign(changed.payload!, change);
    assert.throws(() => validateOperationalIdentity(changed), /旧运营资料保全声明/);
  }
});

test('真实导入保存及幂等更新保全声明，后续权威导出省略时清除旧声明', async () => {
  const place = fixture(), client = await pool.connect();
  await client.query('BEGIN');
  try {
    await client.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,payload,created_at)
      VALUES($1,$2,$3,'文化','xhs',true,'{}',now())`, [place.id, place.city, place.name]);
    for (let i = 0; i < 2; i++) {
      const prepared = await prepareImportedPlaces(client, place.city, [{ ...place, payload: place.payload! }]);
      await reconcileImportedPlaces(client, place.city, prepared);
      const { rows: [row] } = await client.query('SELECT payload FROM canonical_places WHERE id=$1', [place.id]);
      assert.deepEqual(row.payload.operationalIdentity, place.payload!.operationalIdentity);
      assert.equal(row.payload.price, place.payload!.price);
    }
    const changed = structuredClone(place);
    changed.payload!.price = '伪造新价';
    await assert.rejects(prepareImportedPlaces(client, place.city, [{ ...changed, payload: changed.payload! }]), /旧运营资料保全声明/);
    delete place.payload!.operationalIdentity;
    const prepared = await prepareImportedPlaces(client, place.city, [{ ...place, payload: place.payload! }]);
    await reconcileImportedPlaces(client, place.city, prepared);
    const { rows: [row] } = await client.query('SELECT payload FROM canonical_places WHERE id=$1', [place.id]);
    assert.equal(row.payload.operationalIdentity, undefined);
    assert.equal(row.payload.price, place.payload!.price);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
