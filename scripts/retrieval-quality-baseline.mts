// 只读检索质量基线：字面层覆盖面 + 召回基线；带 --variants 时跑消融矩阵。
// 缺省零外部调用（不调 LLM / embedding / 地图）；--variants 中 vector 非 off 的变体会调用站点 embedding。
// npm run eval:retrieval [--out <dir>] [--variants <path.json>]
import { config } from 'dotenv';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool, type QueryResultRow } from 'pg';
import { createPlaceRetriever, type RetrievalDiagnostics } from '../apps/server/src/generation/placeRetrieval';
import { canonicalPlaceId } from '../apps/server/src/lib/placeIdentity';
import { configFingerprint, literalCoverage, parseVariantSpecs, realAliases, recallMetrics,
  renderRetrievalQuality, renderVariantComparison, retrievalQualityReport,
  type ChannelStats, type PlaceCoverageRow, type RecallCase, type RecallMetrics, type VariantSpec, type VectorMode } from '../eval/retrievalQuality';

config({ path: 'apps/server/.env', quiet: true });
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('缺 DATABASE_URL（apps/server/.env）；本探针只接受只读业务库连接。');
  process.exit(2);
}

const DEPTH = 8;
const MIN_SUBSET_QUERY_CHARS = 25;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要参数`);
  return value;
}

function assertKnownArgs(): void {
  const known = new Set(['--out', '--variants']);
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (known.has(args[i]!)) { i += 1; continue; }
    throw new Error(`未知参数「${args[i]}」；允许：--out <dir> / --variants <path.json>`);
  }
}

const nullEmbed = async (): Promise<number[] | null> => null;
let siteEmbed: ((text: string, signal?: AbortSignal) => Promise<number[] | null>) | undefined;
/** 只有需要向量的变体才加载站点 embedding 客户端，缺省路径保持零外部调用。 */
async function embedFor(mode: VectorMode): Promise<(text: string, signal?: AbortSignal) => Promise<number[] | null>> {
  if (mode === 'off') return nullEmbed;
  if (!siteEmbed) {
    const module = await import('../apps/server/src/integrations/embedding');
    siteEmbed = module.embedQuery;
  }
  return siteEmbed;
}

interface SubsetQuery { city: string; query: string; expectId: string; expectName: string }
interface Subset { name: string; method: string; queries: SubsetQuery[] }

const database = new Pool({ connectionString, max: 2, options: '-c default_transaction_read_only=on',
  connectionTimeoutMillis: 8000, statement_timeout: 60000 });
const retrieve = createPlaceRetriever({ query: (sql, values) => database.query(sql, values), embed: nullEmbed });

/** 子集 A：已登记别名与金集主名的可用性回归门。 */
function regressionSubset(places: readonly PlaceCoverageRow[]): Subset {
  const queries: SubsetQuery[] = [];
  for (const place of places) {
    // 期望值是规范实体 ID：成员行合并后返回的是根行，按行 ID 会漏判。
    const expectId = canonicalPlaceId(place);
    if (place.source === 'goldset') queries.push({ city: place.city, query: place.name, expectId, expectName: place.name });
    const alias = realAliases(place)[0];
    if (alias) queries.push({ city: place.city, query: alias, expectId, expectName: place.name });
  }
  return {
    name: 'regression',
    method: 'source=goldset 的主名 + 每个地点首个真别名。这一集预期字面即可命中，用于守住「已登记别名仍可用」，不用于衡量语义能力。',
    queries,
  };
}

/** 子集 B：笔记原文片段，去掉含地点名的样本 —— 字面层必然落空，是向量增量的唯一信息源。 */
async function literalFailSubset(): Promise<Subset> {
  const { rows } = await database.query<{ place_id: string; city: string; name: string; entity_id: string | null; content: string } & QueryResultRow>(
    `SELECT DISTINCT ON (e.place_id) e.place_id, c.city, c.name,
       c.payload->'identity'->>'entityId' AS entity_id, left(e.content, 200) AS content
     FROM research_evidence e JOIN canonical_places c ON c.id = e.place_id
     WHERE c.verified = TRUE AND c.payload->>'canonicalRedirectTo' IS NULL
       AND length(e.content) >= $1 AND strpos(e.content, c.name) = 0
     ORDER BY e.place_id, length(e.content) DESC`, [MIN_SUBSET_QUERY_CHARS]);
  return {
    name: 'literalFail',
    method: `research_evidence.content 原文片段（不含其地点名、长度 ≥ ${MIN_SUBSET_QUERY_CHARS}、每地点取最长一条）。`
      + '测的是「笔记描述 → 找到地点」，不是「用户搜索意图 → 找到地点」：真实用户不会照抄笔记文本，'
      + '所以本集召回率既不是上界也不是下界，只提供一个「字面必失败、语义可能成功」的可复现对照。',
    queries: rows.map((row) => ({ city: row.city, query: row.content, expectName: row.name,
      expectId: row.entity_id?.trim() || row.place_id })),
  };
}

async function runSubset(subset: Subset, spec: VariantSpec): Promise<{ cases: RecallCase[]; stats: ChannelStats }> {
  const embed = await embedFor(spec.vector);
  const retriever = spec.vector === 'off' ? retrieve : createPlaceRetriever({ query: (sql, values) => database.query(sql, values), embed });
  const limit = spec.limit ?? DEPTH;
  const cases: RecallCase[] = [];
  const stats: ChannelStats = { keywordHits: 0, vectorHits: 0, vectorSelected: 0, embedFailures: 0, skippedFilled: 0 };
  for (const [index, item] of subset.queries.entries()) {
    let diagnostics: RetrievalDiagnostics | undefined;
    const hits = await retriever([item.query], { city: item.city, vector: spec.vector, limit,
      onDiagnostics: (value) => { diagnostics = value; } });
    if (diagnostics) {
      stats.keywordHits += diagnostics.keywordHits;
      stats.vectorHits += diagnostics.vectorHits;
      stats.vectorSelected += diagnostics.vectorSelected;
      if (diagnostics.vector === 'failed') stats.embedFailures += 1;
      if (diagnostics.vector === 'skipped:filled') stats.skippedFilled += 1;
    }
    cases.push({ city: item.city, query: item.query, expectId: item.expectId, expectName: item.expectName,
      hitGroups: hits.map((hit) => [canonicalPlaceId(hit), hit.id]), actualNames: hits.map((hit) => hit.name) });
    if ((index + 1) % 50 === 0) process.stderr.write(`  ${subset.name} 已检索 ${index + 1}/${subset.queries.length}\n`);
  }
  return { cases, stats };
}

async function writeReport(dir: string, report: unknown): Promise<void> {
  // 报告内不含时间戳或耗时，同一知识库同一参数两次运行的 report.json 逐字段相等。
  await mkdir(dir, { recursive: true });
  const target = join(dir, 'report.json');
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n报告已写入 ${target}`);
}

async function main(): Promise<void> {
  assertKnownArgs();
  const outDir = flag('--out');
  const variantsPath = flag('--variants');
  await database.query('SELECT 1');

  // 只取统计所需字段：payload 不搬运 content 等大字段，与 placeRetrieval 的精简列一致。
  const { rows } = await database.query<PlaceCoverageRow & { has_evidence: boolean } & QueryResultRow>(
    `SELECT c.id, c.city, c.name, c.category, c.source,
       jsonb_build_object('aliases', c.payload->'aliases', 'themes', c.payload->'themes') AS payload,
       EXISTS (SELECT 1 FROM research_evidence e WHERE e.place_id = c.id) AS has_evidence
     FROM canonical_places c
     WHERE c.verified = TRUE AND c.payload->>'canonicalRedirectTo' IS NULL
     ORDER BY c.city, c.name, c.id`);
  const places: PlaceCoverageRow[] = rows.map((row) => ({ id: row.id, city: row.city, name: row.name, category: row.category,
    source: row.source, payload: row.payload, hasEvidence: row.has_evidence }));

  if (!variantsPath) {
    // 缺省路径与引入消融矩阵之前保持同一行为：单变体、字面层、零外部调用。
    const subset = regressionSubset(places);
    const cases = await runSubset(subset, { label: 'off', vector: 'off' });
    const report = retrievalQualityReport(places, cases, DEPTH);
    console.log(renderRetrievalQuality(report));
    if (outDir) await writeReport(outDir, report);
    return;
  }

  const specs = parseVariantSpecs(JSON.parse(await readFile(variantsPath, 'utf8')));
  const subsets = [regressionSubset(places), await literalFailSubset()];
  const variants = [];
  for (const spec of specs) {
    const config = { vector: spec.vector, limit: spec.limit ?? DEPTH };
    const recall: Record<string, RecallMetrics> = {};
    const channels: Record<string, ChannelStats> = {};
    for (const subset of subsets) {
      const outcome = await runSubset(subset, spec);
      recall[subset.name] = recallMetrics(outcome.cases, spec.limit ?? DEPTH);
      channels[subset.name] = outcome.stats;
    }
    variants.push({ label: spec.label, config, fingerprint: configFingerprint(config), recall, channels });
  }
  const report = { coverage: literalCoverage(places),
    subsets: subsets.map((subset) => ({ name: subset.name, queries: subset.queries.length, method: subset.method })), variants };
  console.log(renderVariantComparison(report));
  if (outDir) await writeReport(outDir, report);
}

try {
  await main();
} catch (err) {
  console.error(`检索质量基线失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await database.end();
}
