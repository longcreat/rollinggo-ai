import { parseArgs } from 'node:util';
import { exportKnowledge, sourceConfiguration } from './exportKnowledge';
import { saveFrozen, summarizeFrozen } from './frozenKnowledge';

async function main() {
  const { values } = parseArgs({ options: { name: { type: 'string' }, cities: { type: 'string' }, out: { type: 'string' },
    'without-vectors': { type: 'boolean', default: false }, help: { type: 'boolean' } }, strict: true });
  if (values.help) { console.log('npm run eval:knowledge:export -- --name <版本名称> [--cities 北京,上海] [--without-vectors] [--out 根目录]'); return; }
  if (!values.name) throw new Error('必须指定 --name，已有版本不覆盖');
  const config = sourceConfiguration();
  const cities = values.cities?.split(',').map((c) => c.trim()).filter(Boolean);
  const snapshot = await exportKnowledge({ ...config, name: values.name, cities, includeVectors: !values['without-vectors'] });
  const directory = saveFrozen(snapshot, values.out);
  const summary = summarizeFrozen(snapshot);
  console.log(JSON.stringify({ directory, ...summary }, null, 2));
}
main().catch((error: unknown) => {
  // 不输出驱动堆栈、连接串或 SQL 错误 detail。
  const message = error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/g, '[source]') : '知识库导出失败';
  console.error(message.slice(0, 500)); process.exitCode = 2;
});
