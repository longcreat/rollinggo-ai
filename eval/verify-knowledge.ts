import assert from 'node:assert/strict';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { runMigrations } from '../apps/server/src/db/migrate';
import { EVAL_DIR, hash, writeJson } from './artifacts';
import { createEvaluationDatabase } from './isolation';
import { exportKnowledge } from './exportKnowledge';
import { readFrozen, seedFrozen, vectorColumns, type FrozenKnowledge } from './frozenKnowledge';
import { verifyFrozenImport } from './knowledgeVerification';

async function selfTest(adminUrl: string | undefined): Promise<FrozenKnowledge> {
  const source = await createEvaluationDatabase(adminUrl);
  const pool = new Pool({ connectionString: source.url });
  try {
    await runMigrations(pool);
    await pool.query(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('private-account','do-not-export@example.test','PRIVATE-SECRET',NOW())`);
    await pool.query(`INSERT INTO canonical_places (id,city,name,category,lat,lng,source,verified,payload,created_at) VALUES
      ('a','北京','故宫','文化',39.91,116.40,'xhs',TRUE,$1,'2026-01-01'),
      ('b','北京','景山','文化',39.92,116.41,'xhs',TRUE,$2,'2026-01-01'),
      ('c','上海','上海公园','自然',31.23,121.47,'manual',FALSE,NULL,'2026-01-01')`,
    [{ aliases: ['紫禁城'], recommendScore: 95, mentionCount: 88, typicalVisitMinutes: 240,
      openHours: { closedDays: [1] }, reservation: 'required', content: { version: 1, intro: '历史宫殿。' }, rawUserToken: 'PRIVATE-SECRET' },
    { canonicalRedirectTo: 'a', aliases: ['景山公园'], themes: ['文化'] }]);
    await pool.query(`INSERT INTO research_evidence (id,place_id,city,kind,strength,content,source_url,fetched_at) VALUES
      ('e','a','北京','xhs_reservation','direct','周一闭馆，参观需要预约','https://example.test/source','2026-01-01'),
      ('free',NULL,'北京','official','direct','城市介绍','https://example.test/city','2026-01-01'),
      ('dangling','missing','北京','official','direct','悬空证据','https://example.test/bad','2026-01-01')`);
    await pool.query(`INSERT INTO place_relation (id,city,from_name,to_name,strength,note_count,created_at)
      VALUES ('r','北京','故宫','景山','direct',3,'2026-01-01')`);
    const columns = await vectorColumns(pool);
    if (columns.places && columns.evidence) {
      const vector = JSON.stringify(Array.from({ length: columns.places }, (_, i) => i === 0 ? 1 : 0));
      await pool.query("UPDATE canonical_places SET embedding=$1::vector WHERE id='a'", [vector]);
      await pool.query("UPDATE research_evidence SET embedding=$1::vector WHERE id='e'", [vector]);
    }
    const options = { url: source.url, name: 'self-test', cities: ['北京'], includeVectors: true, configuredModel: 'test-model' };
    const frozen = await exportKnowledge(options);
    assert.equal(frozen.data.places.length, 2);
    assert.equal(frozen.data.evidence.length, 2);
    assert.equal(frozen.data.relations.length, 1);
    assert.ok(!JSON.stringify(frozen).includes('PRIVATE-SECRET'));
    assert.ok(!JSON.stringify(frozen).includes('do-not-export@example.test'));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1);
    assert.equal((await exportKnowledge(options)).contentHash, frozen.contentHash, '无数据变更时内容 hash 应一致');
    assert.equal((await exportKnowledge({ ...options, cities: undefined })).data.places.length, 3, '全量导出应保留未验证地点以重现过滤');
    await assert.rejects(exportKnowledge({ ...options, cities: ['不存在'] }), /不存在/);
    // 目标已非空时不能混入副本，也不能损坏已有数据。
    await assert.rejects(seedFrozen(pool, frozen, false), /非空/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM canonical_places')).rows[0].n, 3);
    const noVectorDb = await createEvaluationDatabase(adminUrl);
    const noVectorPool = new Pool({ connectionString: noVectorDb.url });
    try {
      await runMigrations(noVectorPool);
      await noVectorPool.query('ALTER TABLE canonical_places DROP COLUMN IF EXISTS embedding');
      await noVectorPool.query('ALTER TABLE research_evidence DROP COLUMN IF EXISTS embedding');
      const vectorFixture = structuredClone(frozen);
      vectorFixture.data.vectors = { included: true, placeDimensions: 3, evidenceDimensions: null, configuredModel: 'test-model' };
      for (const p of vectorFixture.data.places) p.embedding = '[1,0,0]';
      for (const e of vectorFixture.data.evidence) e.embedding = null;
      vectorFixture.contentHash = hash(vectorFixture.data);
      await assert.rejects(seedFrozen(noVectorPool, vectorFixture, false), /pgvector/);
      assert.equal((await noVectorPool.query('SELECT count(*)::int AS n FROM canonical_places')).rows[0].n, 0);
      await seedFrozen(noVectorPool, vectorFixture, true);
      assert.equal((await noVectorPool.query('SELECT count(*)::int AS n FROM canonical_places')).rows[0].n, 2);
    } finally { try { await noVectorPool.end(); } finally { await noVectorDb.close(); } }
    return frozen;
  } finally { try { await pool.end(); } finally { await source.close(); } }
}

async function main() {
  const { values } = parseArgs({ options: { snapshot: { type: 'string' }, 'skip-vectors': { type: 'boolean', default: false },
    'self-test': { type: 'boolean', default: false } }, strict: true });
  if (Boolean(values.snapshot) === values['self-test']) throw new Error('指定 --snapshot <目录> 或 --self-test 其中一种');
  const snapshot = values['self-test'] ? await selfTest(process.env.EVAL_PG_ADMIN_URL) : readFrozen(values.snapshot!);
  const result = await verifyFrozenImport(snapshot, process.env.EVAL_PG_ADMIN_URL, values['skip-vectors']);
  if (values['self-test']) await verifyFrozenImport(snapshot, process.env.EVAL_PG_ADMIN_URL, true);
  const directory = path.join(EVAL_DIR, 'runs', `verify-knowledge-${Date.now()}`);
  writeJson(path.join(directory, 'verification.json'), { ...result, isolatedDatabaseCleaned: true });
  console.log(JSON.stringify({ ...result, isolatedDatabaseCleaned: true, directory }, null, 2));
}
main().catch((error: unknown) => {
  console.error((error instanceof Error ? error.message : '知识库验证失败').replace(/postgres(?:ql)?:\/\/\S+/g, '[database]').slice(0, 1000));
  process.exitCode = 2;
});
