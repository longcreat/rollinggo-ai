// 生成本地素材：分享海报底部的品牌带（1024×96，含域名与中文标识）。
// 为什么用预渲染 PNG 而不是运行时渲染文字：生产镜像是 node:22-alpine，没有中文字体，
// 运行时用 SVG 渲染中文会出方框。这里在开发机（有中文字体）上一次性画好，产物提交入库，
// 运行时只做「贴图 + 贴二维码」，不渲染任何文字。
//
// 用法：node --import tsx scripts/generate-share-brand-band.mts
// 产物：apps/server/assets/share-brand-{journal,ink}.png
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const WIDTH = 1024;
// 高度与运行时合成模块保持一致（BAND_HEIGHT）。右侧留 160px 给二维码（含白边与右外边距）。
const HEIGHT = 144;
const OUT_DIR = path.resolve('apps/server/assets');
// 容器里跑不到本脚本；这份字体栈只在开发机生效
const FONT = 'Microsoft YaHei, PingFang SC, Noto Sans CJK SC, Source Han Sans SC, sans-serif';

const STYLES = {
  journal: { bg: '#f7f3ea', ink: '#2f2a24', accent: '#2f6f8f' },
  ink: { bg: '#f2ece0', ink: '#26221d', accent: '#8c5a4a' },
} as const;

await mkdir(OUT_DIR, { recursive: true });

for (const [style, color] of Object.entries(STYLES)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${color.bg}"/>
  <rect x="0" y="0" width="${WIDTH}" height="2" fill="${color.accent}" opacity="0.4"/>
  <text x="40" y="62" font-family="${FONT}" font-size="30" font-weight="600" fill="${color.ink}">sakiiko.com</text>
  <text x="40" y="98" font-family="${FONT}" font-size="18" fill="${color.ink}" fill-opacity="0.62">织程 TripWeaver · AI 生成</text>
</svg>`;
  const file = path.join(OUT_DIR, `share-brand-${style}.png`);
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(file);
  const meta = await sharp(file).metadata();
  console.log(`${file} ${meta.width}×${meta.height} ${(await sharp(file).toBuffer()).length}B`);
}
