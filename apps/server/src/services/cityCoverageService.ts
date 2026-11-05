// 城市覆盖检测（09-25 未覆盖城市诚实降级 R1）：
// 按目的地城市统计 canonical_places 的 verified 条数，低于阈值判为「未充分覆盖」。
//
// 阈值依据（09-25 生产库实测）：北京 1349 / 成都 411，断层之下 ≤21（青岛 21、重庆 19、
// 上海 13、其余 ≤9），100 一个数即可把两档干净分开。
// 结果按城市进程内缓存：城市数据只在离线采集导入时变化，运行期内不会变，无需 TTL。
import { and, count, desc, eq, gte, ne } from 'drizzle-orm';
import { db } from '../db/client';
import { canonicalPlaces } from '../db/schema';

/** 已验证条数达到该值即视为「充分覆盖」；调整采集策略时改这里 */
export const CITY_COVERAGE_THRESHOLD = 100;

/** 调研阶段 search_web 调用上限：覆盖城市收紧（知识库为主力），未覆盖城市放宽（实时搜索补位） */
export const SEARCH_WEB_MAX_COVERED = 2;
export const SEARCH_WEB_MAX_UNCOVERED = 6;

export type CityCoverage = 'covered' | 'uncovered';

/** 阈值判定纯函数（单测覆盖边界）；cityCoverage 的 DB 路径由 verify-c2 覆盖 */
export function coverageFromCount(verifiedCount: number): CityCoverage {
  return verifiedCount >= CITY_COVERAGE_THRESHOLD ? 'covered' : 'uncovered';
}

const cache = new Map<string, CityCoverage>();

/** 查询某城市的知识库覆盖档位。目的地为空串/空白时按未覆盖处理（诚实降级：宁提示勿漏提示） */
export async function cityCoverage(destination: string): Promise<CityCoverage> {
  const city = destination.trim();
  if (!city) return 'uncovered';
  const hit = cache.get(city);
  if (hit) return hit;
  const [row] = await db
    .select({ n: count() })
    .from(canonicalPlaces)
    .where(and(eq(canonicalPlaces.city, city), eq(canonicalPlaces.verified, true)));
  const n = Number(row?.n ?? 0);
  const coverage = n > 0 ? 'covered' : 'uncovered';
  cache.set(city, coverage);
  return coverage;
}

/** 测试用：清空进程内缓存 */
export function resetCityCoverageCache(): void {
  cache.clear();
  coveredCitiesCache = null;
}

let coveredCitiesCache: string[] | null = null;

/**
 * 已覆盖城市列表（09-26 城市选择首页）：verified 条数达阈值的城市，按条数降序。
 * 与 cityCoverage 同策略：进程内缓存无 TTL——城市数据只在离线采集导入时变化。
 */
export async function listCoveredCities(): Promise<string[]> {
  if (coveredCitiesCache) return coveredCitiesCache;
  let rows = await db
    .select({ city: canonicalPlaces.city, n: count() })
    .from(canonicalPlaces)
    .where(and(eq(canonicalPlaces.verified, true), ne(canonicalPlaces.city, '')))
    .groupBy(canonicalPlaces.city)
    .having(gte(count(), CITY_COVERAGE_THRESHOLD))
    .orderBy(desc(count()));

  // 兜底：本地开发/初次部署数据未超 100 条时，回落到库内所有已验证城市
  if (rows.length === 0) {
    rows = await db
      .select({ city: canonicalPlaces.city, n: count() })
      .from(canonicalPlaces)
      .where(and(eq(canonicalPlaces.verified, true), ne(canonicalPlaces.city, '')))
      .groupBy(canonicalPlaces.city)
      .orderBy(desc(count()));
  }

  coveredCitiesCache = rows.map((row) => row.city);
  return coveredCitiesCache;
}

/** 覆盖档位 → search_web 上限（R3：未覆盖城市放宽实时搜索配额） */
export function searchWebMaxFor(coverage: CityCoverage): number {
  return coverage === 'covered' ? SEARCH_WEB_MAX_COVERED : SEARCH_WEB_MAX_UNCOVERED;
}
