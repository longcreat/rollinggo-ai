// 从业务库导出「手写体文案语料」并按共现重排分片计划。
// 只读连接；输出 scripts/handwriting-chunks.json（只含字符，不落原文、不落凭据）。
//   node --import tsx scripts/extract-handwriting-corpus.mts
//
// 分片思路：手写体只用于短文案（地点名 / 目的地 / 日标题）。按码位切分会让一条
// 5 字标题横跨 4~6 片，逐片 swap 造成字体混排。这里改为：
//   1. 出现在大量条目里的公共字（园/山/路/街…）单独成片，一次加载全局复用；
//   2. 其余字按「同一条文案里共现」建图做凝聚聚类，让常一起出现的字留在同一片；
//   3. 剩余生僻字仍按码位交给 build-handwriting-font.py 切块。
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { Pool } from 'pg';

config({ path: 'apps/server/.env', quiet: true });
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('缺 DATABASE_URL（apps/server/.env）。');
  process.exit(2);
}

/** 每片字符上限；与 build-handwriting-font.py 的 CHUNK 保持一致。 */
const CAP = 96;
/** 出现在这么多条目里就算公共字，单独成片。 */
const COMMON_MIN_DF = 80;

const pool = new Pool({
  connectionString,
  max: 2,
  options: '-c default_transaction_read_only=on',
  connectionTimeoutMillis: 8000,
  statement_timeout: 20000,
});

const places = await pool.query<{ name: string | null; city: string | null }>(
  'select name, city from canonical_places',
);
const trips = await pool.query<{ destination: string | null; data: unknown }>(
  'select destination, data from trips',
);
await pool.end();

const entries = new Set<string>();
const push = (value: unknown) => {
  if (typeof value !== 'string') return;
  const text = value.replace(/\s+/g, '');
  if (!text) return;
  // 测试与迁移遗留的合成名字（如「金集并发-<uuid>」）不是真实文案，别进语料。
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(text)) return;
  entries.add(text);
};
for (const row of places.rows) {
  push(row.name);
  push(row.city);
}
for (const row of trips.rows) {
  push(row.destination);
  const days = (row.data as { days?: unknown } | null)?.days;
  if (Array.isArray(days)) {
    for (const day of days) push((day as { title?: unknown } | null)?.title);
  }
}

const sortedEntries = [...entries];
if (!sortedEntries.length) {
  console.error('语料为空：没有取到地点名或日标题。');
  process.exit(1);
}

// 文档频次：字出现在多少条目里（公共字判定 + 聚类权重）。
const df = new Map<string, number>();
for (const entry of sortedEntries) {
  for (const character of new Set(entry)) df.set(character, (df.get(character) ?? 0) + 1);
}

const common = [...df.entries()]
  .filter(([, count]) => count >= COMMON_MIN_DF)
  .sort((a, b) => b[1] - a[1])
  .map(([character]) => character);
const commonChunks = Math.ceil(common.length / CAP);
const chunks: string[][] = [];
for (let start = 0; start < common.length; start += CAP) {
  chunks.push(common.slice(start, start + CAP));
}
const planned = new Set(common);

// ---- 共现聚类：字为节点，同一条文案内共现一次 = 一条边，权重相加 ----
const rest = [...df.keys()].filter((character) => !planned.has(character));
const indexOf = new Map(rest.map((character, index) => [character, index]));
const edges = new Map<number, number>();
const pairKey = (a: number, b: number) => (a < b ? a * rest.length + b : b * rest.length + a);
for (const entry of sortedEntries) {
  const nodes = [...new Set(entry)]
    .map((character) => indexOf.get(character))
    .filter((index): index is number => index !== undefined);
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const key = pairKey(nodes[i], nodes[j]);
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
}

// 簇级邻接表：cluster -> (cluster -> 权重)
const adj = new Map<number, Map<number, number>>();
const size = new Map<number, number>();
const members = new Map<number, string[]>();
for (let index = 0; index < rest.length; index += 1) {
  adj.set(index, new Map());
  size.set(index, 1);
  members.set(index, [rest[index]]);
}
for (const [key, weight] of edges) {
  const a = Math.floor(key / rest.length);
  const b = key % rest.length;
  adj.get(a)!.set(b, weight);
  adj.get(b)!.set(a, weight);
}

// 大顶堆（惰性删除：弹出后校验权重仍然有效）
const heap: { a: number; b: number; weight: number }[] = [];
const swap = (i: number, j: number) => {
  const temp = heap[i];
  heap[i] = heap[j];
  heap[j] = temp;
};
const pushEdge = (edge: { a: number; b: number; weight: number }) => {
  heap.push(edge);
  let child = heap.length - 1;
  while (child > 0) {
    const parent = (child - 1) >> 1;
    if (heap[parent].weight >= heap[child].weight) break;
    swap(parent, child);
    child = parent;
  }
};
const popEdge = () => {
  const top = heap[0];
  const last = heap.pop()!;
  if (heap.length) {
    heap[0] = last;
    let parent = 0;
    for (;;) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let largest = parent;
      if (left < heap.length && heap[left].weight > heap[largest].weight) largest = left;
      if (right < heap.length && heap[right].weight > heap[largest].weight) largest = right;
      if (largest === parent) break;
      swap(parent, largest);
      parent = largest;
    }
  }
  return top;
};
for (const [key, weight] of edges) {
  pushEdge({ a: Math.floor(key / rest.length), b: key % rest.length, weight });
}

const alive = new Set(rest.map((_, index) => index));
while (heap.length) {
  const { a, b, weight } = popEdge();
  if (!alive.has(a) || !alive.has(b)) continue;
  if (adj.get(a)?.get(b) !== weight || adj.get(b)?.get(a) !== weight) continue;
  if (size.get(a)! + size.get(b)! > CAP) continue;
  // 把 b 并入 a
  const adjA = adj.get(a)!;
  for (const [other, otherWeight] of adj.get(b)!) {
    if (other === a) continue;
    const merged = (adjA.get(other) ?? 0) + otherWeight;
    adjA.set(other, merged);
    adj.get(other)!.set(a, merged);
    adj.get(other)!.delete(b);
    pushEdge({ a, b: other, weight: merged });
  }
  adjA.delete(b);
  adj.delete(b);
  alive.delete(b);
  size.set(a, size.get(a)! + size.get(b)!);
  members.get(a)!.push(...members.get(b)!);
  members.delete(b);
}

// 碎片簇（只出现在一两条文案里的生僻字）按码位打包，避免一堆单字片。
const solid: string[][] = [];
const debris: string[] = [];
for (const id of alive) {
  const group = members.get(id)!;
  if (group.length <= 4) debris.push(...group);
  else solid.push(group);
}
chunks.push(...solid);
for (let start = 0; start < debris.length; start += CAP) {
  chunks.push(debris.slice(start, start + CAP));
}
for (const character of rest) planned.add(character);

// ---- 局部优化：把同一条文案里散落的字搬回它出现最多的那片 ----
// 聚类只能保证「强共现的字靠近」，共享字（公园 / 博物馆）仍会把一条标题拆开。
// 这里按条目逐字搬回主片；主片满了就用目标片里最生僻的字交换出去。
const chunkOfCharacter = new Map<string, number>();
chunks.forEach((chunk, index) => {
  for (const character of chunk) chunkOfCharacter.set(character, index);
});
const measure = () => {
  let total = 0;
  for (const entry of sortedEntries) {
    const used = new Set<number>();
    for (const character of new Set(entry)) {
      const index = chunkOfCharacter.get(character);
      if (index !== undefined) used.add(index);
    }
    total += used.size;
  }
  return total / sortedEntries.length;
};
const moveCharacter = (character: string, from: number, to: number) => {
  const source = chunks[from];
  const at = source.indexOf(character);
  if (at < 0) return;
  source.splice(at, 1);
  chunks[to].push(character);
  chunkOfCharacter.set(character, to);
};
const rankOf = new Map(common.map((character, index) => [character, index]));
// 生僻字优先被换出：df 小、且在公共片里的字最不该占文案片的位置。
const pickVictim = (chunkIndex: number, keep: Set<string>) => {
  let victim: string | null = null;
  let victimDf = Infinity;
  for (const character of chunks[chunkIndex]) {
    if (keep.has(character)) continue;
    const count = df.get(character) ?? 0;
    if (count < victimDf) {
      victim = character;
      victimDf = count;
    }
  }
  return victim;
};
const byPieceCount = () =>
  sortedEntries
    .map((entry) => ({
      entry,
      used: new Set([...new Set(entry)].map((c) => chunkOfCharacter.get(c)).filter((i): i is number => i !== undefined)),
    }))
    .sort((a, b) => b.used.size - a.used.size);
let best = measure();
let bestChunks = chunks.map((chunk) => [...chunk]);
for (let round = 0; round < 4; round += 1) {
  for (const { entry, used } of byPieceCount()) {
    if (used.size < 2) continue;
    const counts = new Map<number, number>();
    for (const character of new Set(entry)) {
      const index = chunkOfCharacter.get(character);
      if (index !== undefined) counts.set(index, (counts.get(index) ?? 0) + 1);
    }
    const target = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const entryCharacters = new Set(entry);
    for (const character of entryCharacters) {
      const index = chunkOfCharacter.get(character);
      if (index === undefined || index === target) continue;
      const targetFull = chunks[target].length >= CAP;
      if (!targetFull) {
        moveCharacter(character, index, target);
        continue;
      }
      // 只拿「比当前字更生僻」的字填坑，避免把常字换出去拆散别处标题。
      const victim = pickVictim(target, entryCharacters);
      if (!victim || (df.get(victim) ?? 0) >= (df.get(character) ?? 0)) break;
      moveCharacter(victim, target, index);
      moveCharacter(character, index, target);
    }
  }
  const current = measure();
  console.log(`第 ${round + 1} 轮：单条文案平均命中 ${current.toFixed(2)} 片`);
  if (current < best - 1e-6) {
    best = current;
    bestChunks = chunks.map((chunk) => [...chunk]);
    continue;
  }
  // 不再改进：回滚到上一轮最优快照。
  chunks.length = 0;
  chunks.push(...bestChunks.map((chunk) => [...chunk]));
  chunkOfCharacter.clear();
  chunks.forEach((chunk, index) => {
    for (const character of chunk) chunkOfCharacter.set(character, index);
  });
  break;
}
// 片内按码位排序，让 unicode-range 更紧凑。
const plan = chunks.map((chunk) => chunk.sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!).join(''));

// 统计：一条文案命中多少片（含公共片）。
const chunkOf = new Map<string, number>();
plan.forEach((chunk, index) => {
  for (const character of chunk) chunkOf.set(character, index);
});
const hits = sortedEntries.map((entry) => {
  const used = new Set<number>();
  let missing = 0;
  for (const character of new Set(entry)) {
    const index = chunkOf.get(character);
    if (index === undefined) missing += 1;
    else used.add(index);
  }
  return { entry, chunks: used.size, missing };
});
const covered = hits.filter((hit) => hit.missing === 0);
const average = covered.reduce((sum, hit) => sum + hit.chunks, 0) / Math.max(covered.length, 1);
const worst = covered.reduce((max, hit) => Math.max(max, hit.chunks), 0);
const multi = covered.filter((hit) => hit.chunks > 2).sort((a, b) => b.chunks - a.chunks);

await writeFile(
  fileURLToPath(new URL('./handwriting-chunks.json', import.meta.url)),
  `${JSON.stringify({ cap: CAP, commonMinDf: COMMON_MIN_DF, chunks: plan }, null, 1)}\n`,
  'utf8',
);

console.log(`语料 ${sortedEntries.length} 条 / 不同字符 ${df.size} 个 / 共现边 ${edges.size} 条`);
console.log(`公共片 ${commonChunks} 片（df ≥ ${COMMON_MIN_DF}，共 ${common.length} 字），聚类片 ${solid.length} 片，碎片片 ${plan.length - commonChunks - solid.length} 片`);
console.log(`已规划 ${planned.size} 字，剩余 ${df.size - planned.size} 字按码位切块`);
console.log(`单条文案平均命中 ${average.toFixed(2)} 片，最多 ${worst} 片，>2 片的有 ${multi.length} 条`);
for (const hit of multi.slice(0, 5)) console.log(`  ${hit.entry} → ${hit.chunks} 片`);
