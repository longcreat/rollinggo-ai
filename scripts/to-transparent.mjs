#!/usr/bin/env node
/**
 * 把白底线稿 PNG 批量转成透明 PNG（原地覆盖）。
 *
 * 用法：
 *   node scripts/to-transparent.mjs [dir]
 *
 * dir 省略时默认 apps/web/src/assets/city-landmarks。
 * 只处理目录下第一层的 .png，不递归子目录。
 *
 * 转换规则：alpha = 255 - max(R, G, B)，RGB 置 0，抗锯齿边缘自然得到半透明。
 * 已含透明像素的图会被跳过（幂等保护），避免把透明图二次处理成黑块。
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const DEFAULT_DIR = 'apps/web/src/assets/city-landmarks';
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** 解析 PNG，返回反滤波后的像素缓冲（每像素 3 或 4 字节）。 */
function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('不是合法的 PNG 文件');
  }

  const chunks = [];
  let pos = 8;
  while (pos + 12 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const end = pos + 8 + length;
    if (end + 4 > buf.length) throw new Error('PNG 数据被截断');
    chunks.push({ type, data: buf.subarray(pos + 8, end) });
    if (type === 'IEND') break;
    pos = end + 4;
  }

  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr || ihdr.data.length !== 13) throw new Error('缺少 IHDR');

  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const [bitDepth, colorType, compression, filter, interlace] = ihdr.data.subarray(8, 13);

  if (bitDepth !== 8) throw new Error(`不支持的位深 ${bitDepth}（仅支持 8 位）`);
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`不支持的颜色类型 ${colorType}（仅支持 2 真彩 / 6 真彩+Alpha）`);
  }
  if (compression !== 0 || filter !== 0) throw new Error('不支持的压缩/滤波方式');
  if (interlace !== 0) throw new Error('不支持隔行扫描 PNG');
  if (width === 0 || height === 0) throw new Error('尺寸为 0');

  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  if (idat.length === 0) throw new Error('缺少 IDAT 数据');

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(idat);
  if (raw.length !== height * (stride + 1)) throw new Error('像素数据长度与尺寸不符');

  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filterType = raw[rowStart];
    if (filterType > 4) throw new Error(`未知的行滤波类型 ${filterType}`);
    const src = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let value = src[x];
      if (filterType === 1) value += a;
      else if (filterType === 2) value += b;
      else if (filterType === 3) value += (a + b) >> 1;
      else if (filterType === 4) value += paeth(a, b, c);
      out[x] = value & 0xff;
    }
  }

  return { width, height, channels, pixels };
}

/** 白底转透明：alpha = 255 - max(R, G, B)，RGB 归零。 */
function toTransparent({ width, height, channels, pixels }) {
  const count = width * height;
  const rgba = Buffer.alloc(count * 4);
  for (let i = 0; i < count; i += 1) {
    const src = i * channels;
    if (channels === 4 && pixels[src + 3] < 255) return { rgba, alreadyTransparent: true };
    const lightness = Math.max(pixels[src], pixels[src + 1], pixels[src + 2]);
    rgba[i * 4 + 3] = 255 - lightness;
  }
  return { rgba, alreadyTransparent: false };
}

function encodePng({ width, height, rgba }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function label(fullPath) {
  return relative(process.cwd(), fullPath).split('\\').join('/');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log('用法: node scripts/to-transparent.mjs [dir]');
    console.log(`dir 省略时默认为 ${DEFAULT_DIR}`);
    return;
  }

  const target = resolve(args[0] ?? DEFAULT_DIR);
  let stat;
  try {
    stat = statSync(target);
  } catch {
    console.error(`✗ 目录不存在: ${target}`);
    process.exit(1);
  }
  if (!stat.isDirectory()) {
    console.error(`✗ 不是目录: ${target}`);
    process.exit(1);
  }

  const files = readdirSync(target)
    .filter((name) => name.toLowerCase().endsWith('.png'))
    .sort();
  if (files.length === 0) {
    console.log(`没有找到 PNG 文件: ${target}`);
    return;
  }

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const name of files) {
    const full = join(target, name);
    try {
      const image = decodePng(readFileSync(full));
      const { rgba, alreadyTransparent } = toTransparent(image);
      if (alreadyTransparent) {
        skipped += 1;
        console.log(`- 跳过 ${label(full)}（已含透明像素，避免二次处理）`);
        continue;
      }
      writeFileSync(full, encodePng({ width: image.width, height: image.height, rgba }));
      processed += 1;
      console.log(`✓ 处理 ${label(full)}  ${image.width}x${image.height}`);
    } catch (err) {
      failed += 1;
      console.error(`✗ 失败 ${label(full)}: ${err.message}`);
    }
  }

  console.log(`\n处理 ${processed} / 跳过 ${skipped} / 失败 ${failed}（共 ${files.length} 张）`);
  if (failed > 0) process.exit(1);
}

main();
