// 分享海报品牌带合成（10-20）：验证尺寸、贴图形状与降级路径。
// 用 sharp 现场造一张 1024×1536 的假海报，不依赖生图服务。
import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { applyShareBrand, SHARE_BRAND_LINK } from '../lib/sharePosterBrand';

const poster = (width = 1024, height = 1536, format: 'png' | 'jpeg' = 'png') =>
  sharp({ create: { width, height, channels: 3, background: '#336699' } }).toFormat(format).toBuffer();

/** 取某个矩形区域的平均像素，用来判断「这块是不是被贴了东西」 */
async function regionMean(bytes: Buffer, top: number, left: number, width: number, height: number) {
  const { data, info } = await sharp(bytes).extract({ top, left, width, height }).raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i < data.length; i += info.channels) sum += (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
  return sum / (data.length / info.channels);
}

test('品牌带：1024×1536 海报合成后变 1024×1680，底部被贴上内容', async () => {
  const source = await poster();
  const { bytes, branded } = await applyShareBrand(source, 'journal');
  assert.equal(branded, true);
  const meta = await sharp(bytes).metadata();
  assert.equal(meta.width, 1024);
  assert.equal(meta.height, 1680);

  // 海报本体是纯 #336699，品牌带是奶白 #f7f3ea，两者亮度差很大
  const body = await regionMean(bytes, 100, 100, 50, 50);
  const band = await regionMean(bytes, 1600, 300, 50, 50);
  assert.ok(band > body + 40, `品牌带应比海报本体亮，body=${body} band=${band}`);
});

test('品牌带：左侧有文字、右侧有二维码（判据：区域明暗方差）', async () => {
  const { bytes } = await applyShareBrand(await poster(), 'ink');
  // 品牌带 144px 高，top=1536；左侧文字区 vs 中间空白区
  const textRow = await sharp(bytes).extract({ top: 1580, left: 40, width: 240, height: 50 }).stats();
  assert.ok(textRow.channels[0]!.stdev > 8, `文字区应有明暗变化，stdev=${textRow.channels[0]!.stdev}`);

  // 二维码在右侧：取该区域看是否非纯色
  const qr = await sharp(bytes).extract({ top: 1552, left: 880, width: 110, height: 110 }).stats();
  assert.ok(qr.channels[0]!.stdev > 20, `二维码区应有黑白变化，stdev=${qr.channels[0]!.stdev}`);
});

test('品牌带：非 1024 宽的海报按宽度等比放大品牌带', async () => {
  const { bytes, branded } = await applyShareBrand(await poster(512, 768), 'journal');
  assert.equal(branded, true);
  const meta = await sharp(bytes).metadata();
  assert.equal(meta.width, 512);
  // 品牌带高度按 144/1024 等比缩放
  assert.equal(meta.height, 768 + 72);
});

test('品牌带：JPEG 输入保持 JPEG 输出', async () => {
  const { bytes, branded } = await applyShareBrand(await poster(1024, 1536, 'jpeg'), 'journal');
  assert.equal(branded, true);
  const meta = await sharp(bytes).metadata();
  assert.equal(meta.format, 'jpeg');
});

test('品牌带：无法解析的输入不抛异常，原样返回', async () => {
  const garbage = Buffer.from('not an image');
  const { bytes, branded } = await applyShareBrand(garbage, 'journal');
  assert.equal(branded, false);
  assert.equal(bytes, garbage);
});

test('二维码链接指向站点首页并带来源参数', () => {
  const url = new URL(SHARE_BRAND_LINK);
  assert.equal(url.hostname, 'sakiiko.com');
  assert.equal(url.searchParams.get('from'), 'poster');
});
