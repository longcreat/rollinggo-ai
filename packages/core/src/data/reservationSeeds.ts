// 预约种子表匹配：全国热门「需预约」景点（数据见 reservationSeeds.json，随仓库维护）
// 命中即置信 —— 候选 reservation 强制 required 并附种子来源；离线可用，不依赖任何外部 API
import seedsJson from './reservationSeeds.json';

export interface ReservationSeed {
  name: string;
  aliases: string[];
  note: string;
  sourceUrl: string;
}

const SEEDS: ReservationSeed[] = seedsJson.seeds;

/** 归一化：去空白与常见分隔符号，小写比较 */
function norm(s: string): string {
  return s.toLowerCase().replace(/[\s·・()（）]/g, '');
}

/**
 * 名称/别名匹配。规则：别名 ≥3 字用包含匹配（「九寨沟风景名胜区」命中「九寨沟」），
 * ≤2 字只做全等（避免「故宫」误伤「沈阳故宫」类短词包含误报）
 */
export function matchReservationSeed(name: string): ReservationSeed | null {
  const n = norm(name);
  if (!n) return null;
  for (const seed of SEEDS) {
    for (const alias of [seed.name, ...seed.aliases]) {
      const a = norm(alias);
      if (!a) continue;
      if (a.length >= 3 ? n.includes(a) : n === a) return seed;
    }
  }
  return null;
}
