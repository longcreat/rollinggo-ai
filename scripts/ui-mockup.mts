// 用 GPT-image 的图生图接口（/images/edits），把一张界面截图按提示词重绘成设计稿。
// 用法：node --import tsx scripts/ui-mockup.mts <截图.png> <提示词.txt> <输出.png>
// 尺寸由 UI_MOCKUP_SIZE 控制（GPT-image 只接受 1024x1024 / 1024x1536 / 1536x1024）。
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: 'apps/server/.env', quiet: true });

const [imagePath, promptPath, outPath] = process.argv.slice(2);
if (!imagePath || !promptPath || !outPath) throw new Error('用法: node --import tsx scripts/ui-mockup.mts <截图.png> <提示词.txt> <输出.png>');
const apiKey = process.env.IMAGE_API_KEY ?? '';
const baseUrl = (process.env.IMAGE_API_BASE_URL ?? 'https://xjbh.lol/v1').replace(/\/+$/, '');
const model = process.env.IMAGE_MODEL ?? 'gpt-image2.5';
if (!apiKey) throw new Error('IMAGE_API_KEY 未配置');

const form = new FormData();
form.append('model', model);
form.append('prompt', readFileSync(promptPath, 'utf8').trim());
form.append('size', process.env.UI_MOCKUP_SIZE ?? '1024x1536');
form.append('n', '1');
form.append('image', new Blob([readFileSync(imagePath)], { type: 'image/png' }), basename(imagePath));

console.log(`POST ${baseUrl}/images/edits  model=${model}  size=${process.env.UI_MOCKUP_SIZE ?? '1024x1536'}`);
const response = await fetch(`${baseUrl}/images/edits`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}` },
  body: form,
  signal: AbortSignal.timeout(300_000),
});
const text = await response.text();
if (!response.ok) {
  console.log(`HTTP ${response.status}:`, text.slice(0, 600));
  process.exit(1);
}
const body = JSON.parse(text) as { data?: { b64_json?: string; url?: string }[]; error?: unknown };
const first = body.data?.[0];
if (first?.b64_json) {
  const bytes = Buffer.from(first.b64_json, 'base64');
  writeFileSync(outPath, bytes);
  console.log('OK', outPath, `${bytes.length} bytes`);
} else if (first?.url) {
  writeFileSync(outPath, Buffer.from(await (await fetch(first.url)).arrayBuffer()));
  console.log('OK(url)', outPath);
} else {
  console.log('未返回图片:', text.slice(0, 600));
  process.exit(1);
}
