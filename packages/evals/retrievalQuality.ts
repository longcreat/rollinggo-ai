// 检索质量的纯函数层：字面层覆盖面与召回指标。
// 口径与 .trellis/tasks/10-11-retrieval-quality-baseline/research/retrieval-baseline-findings.md 一致。
// 不连接数据库、不做外部调用：调用方负责取数与执行真实检索，这里只做可单测的统计。
import { createHash } from 'node:crypto';

export interface PlaceCoverageRow {
  id: string;
  city: string;
  name: string;
  category: string;
  source: string;
  /** 只保留统计所需字段（aliases / themes），不搬运 content 等大字段。 */
  payload: Record<string, unknown> | null;
  /** 是否存在 research_evidence 行；对应检索的第二跳。 */
  hasEvidence: boolean;
}

export interface RecallCase {
  city: string;
  query: string;
  /** 目标地点在本轮结果里的期望行 ID。 */
  expectId: string;
  expectName: string;
  /** 每个返回实体的成员行 ID 集合，按检索排序；合并实体时成员 ID 都在这里。 */
  hitGroups: readonly (readonly string[])[];
  /** 与 hitGroups 同序的展示名，供人工核对未命中原因。 */
  actualNames: readonly string[];
}

export interface CityCoverage {
  city: string;
  total: number;
  withRealAlias: number;
  withThemes: number;
  withEvidence: number;
}

export interface LiteralCoverage {
  total: number;
  withRealAlias: number;
  withThemes: number;
  withEvidence: number;
  duplicateNameGroups: number;
  duplicateNameRows: number;
  byCity: CityCoverage[];
  method: string;
}

export interface RecallMetrics {
  total: number;
  depth: number;
  at1: number;
  atDepth: number;
  /** 平均倒数排名：对每条 query 取 1/(排位+1)，未命中或超出 depth 记 0。 */
  mrr: number;
  byCity: Array<{ city: string; total: number; at1: number; atDepth: number }>;
  misses: Array<{ city: string; query: string; expectName: string; actualNames: string[] }>;
  method: string;
}

export interface RetrievalQualityReport {
  coverage: LiteralCoverage;
  recall: RecallMetrics;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const payloadOf = (row: PlaceCoverageRow): Record<string, unknown> => row.payload ?? {};

/**
 * 真别名 = `payload.aliases` 中还有 trim 后不等于主名的写法。
 * 只填充主名本身的 aliases 数组是空覆盖，不能算作别名覆盖率。
 */
export function realAliases(row: PlaceCoverageRow): string[] {
  const name = row.name.trim();
  return strings(payloadOf(row).aliases).filter((alias) => {
    const value = alias.trim();
    return value !== '' && value !== name;
  });
}

export function literalCoverage(rows: readonly PlaceCoverageRow[]): LiteralCoverage {
  const cities = new Map<string, CityCoverage>();
  const nameCounts = new Map<string, number>();
  let withRealAlias = 0;
  let withThemes = 0;
  let withEvidence = 0;
  for (const row of rows) {
    const alias = realAliases(row).length > 0;
    const theme = strings(payloadOf(row).themes).length > 0;
    if (alias) withRealAlias += 1;
    if (theme) withThemes += 1;
    if (row.hasEvidence) withEvidence += 1;
    const nameKey = `${row.city}\u0000${row.name.trim()}`;
    nameCounts.set(nameKey, (nameCounts.get(nameKey) ?? 0) + 1);
    const city = cities.get(row.city) ?? { city: row.city, total: 0, withRealAlias: 0, withThemes: 0, withEvidence: 0 };
    city.total += 1;
    if (alias) city.withRealAlias += 1;
    if (theme) city.withThemes += 1;
    if (row.hasEvidence) city.withEvidence += 1;
    cities.set(row.city, city);
  }
  const duplicates = [...nameCounts.values()].filter((count) => count > 1);
  return {
    total: rows.length,
    withRealAlias,
    withThemes,
    withEvidence,
    duplicateNameGroups: duplicates.length,
    duplicateNameRows: duplicates.reduce((sum, count) => sum + count, 0),
    byCity: [...cities.values()].sort((a, b) => b.total - a.total || a.city.localeCompare(b.city, 'zh-CN')),
    method: '真别名 = payload.aliases 中存在 trim 后不等于主名的元素，只填充主名的数组不计入。证据覆盖指该地点存在 research_evidence 行，'
      + '即检索第二跳有资料可取，不代表资料质量或事实正确性。同城同名按 (city, name) 精确分组，不做归一化。',
  };
}

/**
 * 召回指标。分母是实际执行的 query 数，不是抽样行数 —— 把未参与检索的样本算进分母会得出假指标。
 * 命中判定用返回实体的成员 ID 集合包含目标行 ID；rank 为实体在结果中的下标。
 */
export function recallMetrics(cases: readonly RecallCase[], depth = 8): RecallMetrics {
  let at1 = 0;
  let atDepth = 0;
  let reciprocalSum = 0;
  const cities = new Map<string, { city: string; total: number; at1: number; atDepth: number }>();
  const misses: RecallMetrics['misses'] = [];
  for (const item of cases) {
    const rank = item.hitGroups.findIndex((group) => group.includes(item.expectId));
    const hit = rank >= 0 && rank < depth;
    if (rank === 0) at1 += 1;
    if (hit) { atDepth += 1; reciprocalSum += 1 / (rank + 1); }
    else misses.push({ city: item.city, query: item.query, expectName: item.expectName, actualNames: [...item.actualNames] });
    const city = cities.get(item.city) ?? { city: item.city, total: 0, at1: 0, atDepth: 0 };
    city.total += 1;
    if (rank === 0) city.at1 += 1;
    if (hit) city.atDepth += 1;
    cities.set(item.city, city);
  }
  return {
    total: cases.length,
    depth,
    at1,
    atDepth,
    mrr: cases.length ? reciprocalSum / cases.length : 0,
    byCity: [...cities.values()].sort((a, b) => b.total - a.total || a.city.localeCompare(b.city, 'zh-CN')),
    misses,
    method: `命中判定为返回实体的规范实体 ID（canonicalPlaceId，合并实体共享）包含目标规范 ID；排位取实体在 limit=${depth} 结果中的下标。`
      + '分母是实际执行的 query 数，未参与检索的样本不计入。MRR 对每条 query 取 1/(排位+1) 求均值，未命中或超出 depth 记 0。'
      + '具体跑了哪些通道由变体标签给出，本指标本身不假定通道组合。',
  };
}

export function retrievalQualityReport(rows: readonly PlaceCoverageRow[], cases: readonly RecallCase[], depth = 8): RetrievalQualityReport {
  return { coverage: literalCoverage(rows), recall: recallMetrics(cases, depth) };
}

/** 人读摘要。未命中清单只列前 limit 条，完整清单在 JSON 报告里。 */
export function renderRetrievalQuality(report: RetrievalQualityReport, missLimit = 10): string {
  const percent = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '—');
  const { coverage, recall } = report;
  const lines = [
    `字面层覆盖（${coverage.total} active verified places）`,
    `  真别名        ${String(coverage.withRealAlias).padStart(5)}  ${percent(coverage.withRealAlias, coverage.total)}`,
    `  主题标签      ${String(coverage.withThemes).padStart(5)}  ${percent(coverage.withThemes, coverage.total)}`,
    `  证据覆盖      ${String(coverage.withEvidence).padStart(5)}  ${percent(coverage.withEvidence, coverage.total)}`,
    `  同城同名冲突  ${String(coverage.duplicateNameGroups).padStart(5)} 组 / ${coverage.duplicateNameRows} 行`,
    '',
    `召回（字面层，vector 关闭；${recall.total} 条 query）`,
    `  Recall@1      ${percent(recall.at1, recall.total)}`,
    `  Recall@${recall.depth}      ${percent(recall.atDepth, recall.total)}`,
  ];
  for (const city of recall.byCity) lines.push(`    ${city.city}\t${city.at1}/${city.total} @1\t${city.atDepth}/${city.total} @${recall.depth}`);
  if (recall.misses.length) {
    lines.push('', `未命中 ${recall.misses.length} 条${recall.misses.length > missLimit ? `（只列前 ${missLimit} 条）` : ''}`);
    for (const miss of recall.misses.slice(0, missLimit)) {
      lines.push(`  ${miss.city} 「${miss.query}」→ 期望「${miss.expectName}」，实得 ${miss.actualNames.join(' / ') || '(空)'}`);
    }
  }
  return lines.join('\n');
}

// ---------- 消融矩阵：多变体对比 ----------

export type VectorMode = 'off' | 'auto' | 'force';

export interface VariantSpec {
  label: string;
  vector: VectorMode;
  limit?: number;
}

export const VARIANT_KEYS = ['label', 'vector', 'limit'] as const;
export const VECTOR_MODES: readonly VectorMode[] = ['off', 'auto', 'force'];

/**
 * 解析消融变体定义。未知字段直接报错 —— 静默忽略会让人以为参数生效了，而实际没生效。
 */
export function parseVariantSpecs(raw: unknown): VariantSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('变体定义必须是非空数组');
  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`第 ${index + 1} 个变体不是对象`);
    const record = item as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!(VARIANT_KEYS as readonly string[]).includes(key)) {
        throw new Error(`第 ${index + 1} 个变体含未知参数「${key}」；允许：${VARIANT_KEYS.join(' / ')}`);
      }
    }
    const { label, vector = 'off', limit } = record;
    if (typeof label !== 'string' || !label.trim()) throw new Error(`第 ${index + 1} 个变体缺少 label`);
    if (seen.has(label)) throw new Error(`变体 label 重复：「${label}」`);
    seen.add(label);
    if (typeof vector !== 'string' || !VECTOR_MODES.includes(vector as VectorMode)) {
      throw new Error(`变体「${label}」的 vector 必须是 ${VECTOR_MODES.join(' / ')}`);
    }
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 48)) {
      throw new Error(`变体「${label}」的 limit 必须是 1–48 的整数`);
    }
    const spec: VariantSpec = { label, vector: vector as VectorMode };
    if (limit !== undefined) spec.limit = limit;
    return spec;
  });
}

/**
 * 配置指纹：稳定序列化后取 sha256 前 8 位。用于在报告里确认「以为生效的配置是否真的生效」。
 * 只支持扁平配置（键值均为标量），嵌套值会被 replacer 丢弃。
 */
export function configFingerprint(config: Record<string, unknown>): string {
  const stable = JSON.stringify(config, Object.keys(config).sort());
  return createHash('sha256').update(stable).digest('hex').slice(0, 8);
}

export interface VariantEvaluation {
  label: string;
  config: Record<string, unknown>;
  fingerprint: string;
  /** 键为子集名，值为该子集在该变体下的召回指标。 */
  recall: Record<string, RecallMetrics>;
  /** 键为子集名，值为该子集的通道统计。 */
  channels: Record<string, ChannelStats>;
}

export interface ChannelStats {
  /** 各回关键词命中总数。 */
  keywordHits: number;
  vectorHits: number;
  /**
   * 向量命中最终进入结果的条数。小于 vectorHits 是正常的（受 limit 与排序共同影响），
   * 单独看它不能判定排序有问题：跨变体比较同一子集才有意义。
   */
  vectorSelected: number;
  /** 向量外呼失败的 query 数（没配 KEY、超时、钳位等）。 */
  embedFailures: number;
  /** 字面已填满 limit、按设计未请求向量的 query 数。 */
  skippedFilled: number;
}

export interface VariantReport {
  coverage: LiteralCoverage;
  subsets: Array<{ name: string; queries: number; method: string }>;
  variants: VariantEvaluation[];
}

const asPercent = (part: number, whole: number): number => (whole ? (part / whole) * 100 : 0);

/** 人读摘要。第一个变体作为基准，后续变体标出 Recall@depth 的百分点差值。 */
export function renderVariantComparison(report: VariantReport): string {
  const { coverage, subsets, variants } = report;
  const lines = [
    `字面层覆盖（${coverage.total} active verified places）`,
    `  真别名 ${coverage.withRealAlias}  ${asPercent(coverage.withRealAlias, coverage.total).toFixed(1)}%`
      + `   主题标签 ${coverage.withThemes}  ${asPercent(coverage.withThemes, coverage.total).toFixed(1)}%`
      + `   证据覆盖 ${coverage.withEvidence}  ${asPercent(coverage.withEvidence, coverage.total).toFixed(1)}%`,
    '',
    `子集：${subsets.map((s) => `${s.name}(n=${s.queries})`).join('  ')}`,
    '',
    '变体对比',
  ];
  const base = variants[0];
  for (const variant of variants) {
    lines.push(`  ${variant.label}  [${JSON.stringify(variant.config)}]  指纹 ${variant.fingerprint}`);
    for (const subset of subsets) {
      const metrics = variant.recall[subset.name];
      if (!metrics) continue;
      const delta = base && variant !== base && base.recall[subset.name]
        ? `  ΔRecall@${metrics.depth} ${(asPercent(metrics.atDepth, metrics.total) - asPercent(base.recall[subset.name]!.atDepth, base.recall[subset.name]!.total)).toFixed(1)}pt`
        : '';
      lines.push(`    ${subset.name.padEnd(12)} n=${String(metrics.total).padStart(4)}`
        + `  Recall@1 ${asPercent(metrics.at1, metrics.total).toFixed(1)}%`
        + `  Recall@${metrics.depth} ${asPercent(metrics.atDepth, metrics.total).toFixed(1)}%`
        + `  MRR ${metrics.mrr.toFixed(3)}${delta}`);
      const channels = variant.channels[subset.name];
      if (channels) {
        lines.push(`      关键词命中 ${channels.keywordHits}  向量命中 ${channels.vectorHits}`
          + `  进入结果 ${channels.vectorSelected}`
          + `  外呼失败 ${channels.embedFailures}  字面已足够 ${channels.skippedFilled}`);
      }
    }
  }
  return lines.join('\n');
}
