// 清理历史遗留的独立生成存储（*.generation.sqlite*）与旧版 chat-runs.sqlite。
// 现在对话、子代理与生成任务共用 <userId>.sqlite；旧文件不再被任何代码打开。
// 默认 dry-run，只打印；确认后加 --apply 再删除。
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const dataRoot = fileURLToPath(new URL('../data/', import.meta.url));

const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } } });
const runsDir = join(dataRoot, 'agent-runs');

async function collect(dir: string): Promise<{ path: string; bytes: number }[]> {
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return []; }
  const found: { path: string; bytes: number }[] = [];
  for (const name of names) {
    if (!/\.generation\.sqlite(?:-(?:shm|wal))?$/.test(name) && name !== 'chat-runs.sqlite') continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info?.isFile()) found.push({ path, bytes: info.size });
  }
  return found;
}

const files = [...await collect(runsDir), ...await collect(dataRoot)];
if (!files.length) {
  console.log('没有需要清理的旧存储。');
} else {
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  for (const file of files) console.log(`${values.apply ? '删除' : '待删除'} ${file.path}（${(file.bytes / 1024).toFixed(1)} KB）`);
  console.log(`共 ${files.length} 个文件，${(total / 1024 / 1024).toFixed(2)} MB。`);
  if (values.apply) {
    for (const file of files) await unlink(file.path);
    console.log('已删除。');
  } else {
    console.log('这是 dry-run；确认无误后加 --apply。');
  }
}
