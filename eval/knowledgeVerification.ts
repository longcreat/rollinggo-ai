import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../apps/server/src/db/migrate';
import { createPlaceRetriever } from '../apps/server/src/generation/placeRetrieval';
import { hash } from './artifacts';
import { createEvaluationDatabase } from './isolation';
import { exportKnowledge } from './exportKnowledge';
import { seedFrozen, summarizeFrozen, type FrozenKnowledge } from './frozenKnowledge';

/** 验证仅使用显式 Pool，不导入具有自动连接副作用的 db/client。 */
export async function verifyFrozenImport(snapshot: FrozenKnowledge, adminUrl: string | undefined, skipVectors: boolean) {
  const database = await createEvaluationDatabase(adminUrl);
  const pool = new Pool({ connectionString: database.url, max: 2, statement_timeout: 60000 });
  try {
    await runMigrations(pool);
    await seedFrozen(pool, snapshot, skipVectors);
    const exported = await exportKnowledge({ url: database.url, name: 'roundtrip', includeVectors: !skipVectors && snapshot.data.vectors.included,
      configuredModel: snapshot.data.vectors.configuredModel });
    const source = snapshot.data;
    const expectedPlaces = source.places.map((p) => skipVectors ? { ...p, embedding: null } : p);
    const expectedEvidence = source.evidence.map((e) => skipVectors ? { ...e, embedding: null } : e);
    assert.equal(hash(exported.data.places), hash(expectedPlaces), '地点内容/ID/坐标/向量没有原样恢复');
    assert.equal(hash(exported.data.evidence), hash(expectedEvidence), '证据内容/来源/关联/向量没有原样恢复');
    assert.equal(hash(exported.data.relations), hash(source.relations), '地点关系没有原样恢复');
    const retrieve = createPlaceRetriever({ query: (sql, values) => pool.query(sql, values), embed: async () => null });
    const retrieval: { city: string; returned: number; evidence: number }[] = [];
    for (const city of source.cities) {
      const result = await retrieve([], { city, browse: true, limit: 8, vector: 'off' });
      const hasVisible = source.places.some((p) => p.city === city && p.verified && p.payload?.canonicalRedirectTo == null);
      if (hasVisible) assert.ok(result.length > 0, `${city} 导入后无法检索到地点`);
      assert.ok(result.every((p) => p.city === city), '检索出现跨城串位');
      retrieval.push({ city, returned: result.length, evidence: result.reduce((n, p) => n + p.evidence.length, 0) });
    }
    const vector = !skipVectors && source.places.find((p) => p.embedding !== null)?.embedding;
    if (vector) {
      const result = await pool.query('SELECT id FROM canonical_places WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::vector LIMIT 1', [vector]);
      assert.equal(result.rows.length, 1, '导入后的向量距离查询不可用');
    }
    return { snapshot: snapshot.name, contentHash: snapshot.contentHash, skipVectors,
      counts: summarizeFrozen(exported).counts, retrieval, rowContentHashesMatch: true,
      vectorQueryVerified: Boolean(vector),
    };
  } finally {
    try { await pool.end(); } finally { await database.close(); }
  }
}
