// 导出文件扫描与版本标识（09-27）：让「磁盘上最新的一版」和「库里已导入的一版」可比较。
//
// 背景：import/ 目录里同一城市累积了多份导出，命名还不统一 ——
// xhs-places.json / xhs-places-beijing.json / xhs-places-北京.json 分别是 09-22 / 09-23 / 09-25 的北京。
// 任何写死文件名的默认值都会在某次上游重跑后静默导入过期数据：实测踩到默认读 09-22 那份，
// 而上游已是 09-25，故宫博物院的社区分数因此停在 17.33（应为 137.64），排程把它挤到第 11 位而落选。
//
// 两条约定：
//   1. 选版本一律按 city 分组取「最新」，不按文件名猜
//   2. 版本标识用文件内容的 sha256，不依赖上游产物里有没有 generatedAt
//      （places JSON 有 generatedAt，relations JSON 没有）
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 默认导出目录（tripweaver/import），两个 seed 脚本与新鲜度检查脚本共用 */
export const IMPORT_DIR = path.resolve(__dirname, '../../../../import');

export type ExportSource = 'xhs_places' | 'xhs_relations' | 'xhs_place_images';

export const EXPORT_SOURCES: readonly ExportSource[] = ['xhs_places', 'xhs_relations', 'xhs_place_images'];

export interface ExportFile {
  source: ExportSource;
  city: string;
  filePath: string;
  /** 文件内容的 sha256[:32]，与 data_import.content_hash 同算法 */
  contentHash: string;
  /** JSON 里的 generatedAt；relations 产物没有该字段，回落到文件 mtime 的 YYYY-MM-DD */
  generatedAt: string;
  /** 地点数（places）或关联对数（relations） */
  rowCount: number;
}

/** 只认 xhs-travel-pipeline 导出的这三类产物（顺带排除 backup.dump 等无关文件）。
 *  images 与 places 的正则互斥：`xhs-place-images-` 不匹配 `^xhs-places`（第 10 个字符是 `-` 不是 `s`）。 */
const PATTERNS: readonly { source: ExportSource; test: RegExp }[] = [
  { source: 'xhs_places', test: /^xhs-places.*\.json$/ },
  { source: 'xhs_relations', test: /^xhs-place-relations-.*\.json$/ },
  { source: 'xhs_place_images', test: /^xhs-place-images-.*\.json$/ },
];

function hashFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0, 32);
}

function mtimeDate(filePath: string): string {
  return new Date(fs.statSync(filePath).mtimeMs).toISOString().slice(0, 10);
}

/** 读取单个导出文件并判定身份；无法识别、JSON 损坏或缺 city 时返回 null（不阻断扫描） */
export function readExport(filePath: string): ExportFile | null {
  const base = path.basename(filePath);
  const matched = PATTERNS.find((item) => item.test.test(base));
  if (!matched) return null;
  if (!fs.existsSync(filePath)) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    console.warn(`[exportFiles] ${base} 不是合法 JSON，跳过`);
    return null;
  }
  const city = typeof data.city === 'string' ? data.city.trim() : '';
  if (!city) {
    console.warn(`[exportFiles] ${base} 缺 city 字段，跳过`);
    return null;
  }
  const rows =
    matched.source === 'xhs_places'
      ? data.places
      : matched.source === 'xhs_relations'
        ? data.relations
        : data.images;
  const generatedAt = typeof data.generatedAt === 'string' && data.generatedAt ? data.generatedAt : mtimeDate(filePath);
  return {
    source: matched.source,
    city,
    filePath,
    contentHash: hashFile(filePath),
    generatedAt,
    rowCount: Array.isArray(rows) ? rows.length : 0,
  };
}

/** 扫描目录里全部可识别的导出文件 */
export function scanExports(dir: string = IMPORT_DIR): ExportFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((name) => readExport(path.join(dir, name)))
    .filter((item): item is ExportFile => item !== null);
}

/**
 * 每个 (source, city) 只留最新的一份。
 * `generatedAt` 是 YYYY-MM-DD 字符串，字典序即时间序；同日多份时按文件名排序保证结果确定。
 */
export function latestExports(files: readonly ExportFile[]): ExportFile[] {
  const best = new Map<string, ExportFile>();
  for (const file of files) {
    const key = `${file.source}\u0000${file.city}`;
    const prev = best.get(key);
    const newer =
      !prev ||
      file.generatedAt > prev.generatedAt ||
      (file.generatedAt === prev.generatedAt && file.filePath > prev.filePath);
    if (newer) best.set(key, file);
  }
  return [...best.values()].sort(
    (a, b) => a.source.localeCompare(b.source) || a.city.localeCompare(b.city),
  );
}
