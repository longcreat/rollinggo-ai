import fs from 'node:fs';
import path from 'node:path';
import { readReport, writeJson } from './artifacts';
import { compareReports, comparisonMarkdown } from './compare';

const [baseline, candidate, output, ...extra] = process.argv.slice(2);
try {
  if (!baseline || !candidate || extra.length) throw new Error('用法：npm run eval:diff -- <基线目录或报告> <候选目录或报告> [输出目录]');
  const comparison = compareReports(readReport(baseline), readReport(candidate));
  const markdown = comparisonMarkdown(comparison);
  console.log(markdown);
  if (output) {
    writeJson(path.join(output, 'comparison.json'), comparison);
    fs.writeFileSync(path.join(output, 'comparison.md'), markdown);
  }
  process.exitCode = comparison.exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : '报告比较失败');
  process.exitCode = 2;
}
