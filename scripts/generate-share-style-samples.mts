// 用 IMAGE_API_KEY 真实生图，产出两种风格的静态示例缩略图到 apps/web/public/share-styles/。
// 用法：node --import tsx scripts/generate-share-style-samples.mts
// 费用提示：每次运行都会真实调用 2 次生图接口，不要放进 CI。
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: 'apps/server/.env', quiet: true });
process.env.MASTER_KEY ||= 'a'.repeat(64);

const { makeSampleTrip } = await import('@tripweaver/shared');
const { buildTripSharePrompt, TRIP_SHARE_STYLES } = await import('../apps/server/src/lib/tripSharePrompt');
const { readImageProviders } = await import('../apps/server/src/env');
const { generateShareImage } = await import('../apps/server/src/integrations/imageGeneration');

const providers = readImageProviders(process.env);
if (!providers.length) throw new Error('IMAGE_API_KEY 未配置：无法产出示例缩略图');

const outDir = path.resolve('apps/web/public/share-styles');
await fs.mkdir(outDir, { recursive: true });
const trip = makeSampleTrip();
console.log(`[sample] 示例行程：${trip.destination} · ${trip.title} · ${trip.days.length} 天`);
for (const style of TRIP_SHARE_STYLES) {
  const started = Date.now();
  console.log(`[sample] 生成 ${style} …`);
  const image = await generateShareImage(providers, buildTripSharePrompt(trip, style));
  if (image.mimeType !== 'image/png') throw new Error(`示例图必须是 PNG，实际为 ${image.mimeType}`);
  const bytes = image.bytes;
  const file = path.join(outDir, `${style}.png`);
  await fs.writeFile(file, bytes);
  console.log(`[sample] ${style} → ${file}（${(bytes.length / 1024).toFixed(0)} KB，${((Date.now() - started) / 1000).toFixed(1)}s）`);
}
console.log('[sample] 完成');
