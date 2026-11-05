import { acceptBaseline } from './baseline';

try {
  const [source, name, ...extra] = process.argv.slice(2);
  if (!source || !name || extra.length) throw new Error('用法：npm run eval:accept -- <已验收运行目录> <新基线名称>');
  console.log(`已保存基线：${acceptBaseline(source, name)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : '基线接纳失败');
  process.exitCode = 2;
}
