// 只读知识库探针：不导入 db/client、不运行迁移、不调用外部 embedding/LLM。
// node --import tsx scripts/benchmark-place-retrieval.mts
import { config } from 'dotenv';
import { Pool } from 'pg';
import { createPlaceRetriever } from '../apps/server/src/generation/placeRetrieval';
import { prepareResearchContext } from '../apps/server/src/generation/researchContext';

config({ path: 'apps/server/.env', quiet: true });
const database = new Pool({ connectionString: process.env.DATABASE_URL, max: 2,
  options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 8000, statement_timeout: 8000 });
let vectorRequested = 0;
const retrieve = createPlaceRetriever({ query: (sql, values) => database.query(sql, values),
  embed: async () => { vectorRequested++; return null; } });
try {
  await database.query('SELECT 1');
  for (const [city, terms] of [['北京', ['故宫', '天坛', '历史人文']], ['杭州', ['西湖', '灵隐寺', '自然风光']]] as const) {
    const old = await database.query(`SELECT name FROM canonical_places WHERE verified=TRUE AND city=$3
      AND (name=ANY($1) OR name LIKE ANY($2) OR (jsonb_typeof(payload->'themes')='array' AND payload->'themes' ?| $4::text[]))
      ORDER BY CASE WHEN name=ANY($1) THEN 0 WHEN name LIKE ANY($2) THEN 1 ELSE 2 END,name LIMIT 8`,
    [terms, terms.map((term) => `${term}%`), city, terms]);
    const elapsed: number[] = [];
    let result = await retrieve([...terms], { city, category: 'attraction' });
    vectorRequested = 0;
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      result = await retrieve([...terms], { city, category: 'attraction' });
      elapsed.push(Math.round(performance.now() - start));
    }
    const start = performance.now();
    const prefetch = await prepareResearchContext({ destination: city, days: 3, startDate: '', budgetLevel: '舒适',
      totalBudget: 0, preferences: [city === '北京' ? '文化' : '自然'], partySize: 2, extraNotes: '' }, retrieve);
    console.log(JSON.stringify({ city, oldNames: old.rows.map((row) => row.name),
      newNames: result.map((place) => place.name), retrievalMs: elapsed, vectorRequested,
      prefetchMs: Math.round(performance.now() - start), prefetchNames: prefetch.map((place) => place.name) }));
  }
} finally { await database.end(); }
