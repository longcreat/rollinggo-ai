// 游览顺序种子表匹配（09-23）：高频固定组合的先后硬约束（数据见 routeOrderSeeds.json，随仓库维护）
// 只收有空间/出入口逻辑支撑的关系（故宫南进北出 → 神武门出即景山），不收主观偏好。
// 归一化与别名规则与 reservationSeeds 一致：别名 ≥3 字包含匹配，≤2 字只全等（防「故宫」误伤「沈阳故宫」）。
import seedsJson from './routeOrderSeeds.json';

export interface RouteOrderSeed {
  city: string;
  before: string;
  beforeAliases: string[];
  after: string;
  afterAliases: string[];
  note: string;
}

const SEEDS: RouteOrderSeed[] = seedsJson.seeds;

/** 归一化：去空白与常见分隔符号，小写比较（与 reservationSeeds 同款规则） */
function norm(s: string): string {
  return s.toLowerCase().replace(/[\s·・()（）]/g, '');
}

function matchesName(name: string, canonical: string, aliases: string[]): boolean {
  const n = norm(name);
  if (!n) return false;
  for (const alias of [canonical, ...aliases]) {
    const a = norm(alias);
    if (!a) continue;
    if (a.length >= 3 ? n.includes(a) : n === a) return true;
  }
  return false;
}

/**
 * 给定候选地名集合与城市，产出生效的先后约束（before 必须先于 after 出现在同一条链上）。
 * 两端都命中候选集合才返回——缺一端的约束无意义（没有故宫，景山随便排）。
 * 返回的是候选池里的**实际名称**（不是种子名），供排程直接比对。
 */
export function routeOrderConstraints(city: string, candidateNames: readonly string[]): { before: string; after: string }[] {
  const constraints: { before: string; after: string }[] = [];
  for (const seed of SEEDS) {
    if (seed.city !== city) continue;
    const before = candidateNames.find((name) => matchesName(name, seed.before, seed.beforeAliases));
    const after = candidateNames.find((name) => matchesName(name, seed.after, seed.afterAliases));
    if (before && after && before !== after) constraints.push({ before, after });
  }
  return constraints;
}
