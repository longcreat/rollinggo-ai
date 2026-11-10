// 分享海报的品牌带合成：在 AI 生成的海报底部补一条 96px 品牌带（域名 + 中文标识）与二维码。
//
// 为什么在服务端做而不是让模型画：模型的文字能力不可靠（见 docs/AI_SHARE_IMAGES.md），
// 中文长文本尤其容易糊；二维码模型根本画不出可扫的。
//
// 为什么品牌带是预渲染 PNG：生产镜像 node:22-alpine 没有中文字体，运行时渲染中文会出方框。
// 素材由 scripts/generate-share-brand-band.mts 在开发机生成后提交，这里只做贴图。
//
// 合成必须发生在落盘之前：下载、站内通知、GET /:id/share-image 三个出口都走同一份 bytes，
// 这样不需要在每个出口单独加水印。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import sharp, { type FormatEnum, type OverlayOptions } from 'sharp';
import type { TripShareStyle } from './tripSharePrompt';

/** 二维码内容：带来源参数，便于后续区分「扫码来的」与「直接搜索来的」 */
export const SHARE_BRAND_LINK = 'https://sakiiko.com/?from=poster';

const BAND_WIDTH = 1024;
const BAND_HEIGHT = 144;
// 二维码占海报宽度的 11%（1024 宽时 112px）：太小了手机扫不出来，太大了压品牌带版面
const QR_RATIO = 112 / 1024;
const QR_PADDING_RATIO = 12 / 1024; // 二维码白边
const QR_RIGHT_RATIO = 24 / 1024;   // 二维码距右边缘
const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../assets');

// 进程级缓存：品牌带是静态文件，二维码内容固定，没必要每张海报重算
const bandCache = new Map<string, Buffer>();
let qrCache: Promise<Buffer | null> | null = null;

async function loadBand(style: TripShareStyle, width: number, height: number): Promise<Buffer> {
  const key = `${style}:${width}`;
  const hit = bandCache.get(key);
  if (hit) return hit;
  const raw = await readFile(path.join(ASSETS, `share-brand-${style}.png`));
  const scaled = width === BAND_WIDTH ? raw : await sharp(raw).resize(width, height).png().toBuffer();
  bandCache.set(key, scaled);
  return scaled;
}

/** 二维码生成失败不该阻断海报产出，因此失败一律返回 null，由调用方降级为「只贴品牌带」 */
function loadQr(edge: number): Promise<Buffer | null> {
  if (!qrCache) {
    qrCache = (async () => {
      try {
        const code = await QRCode.toBuffer(SHARE_BRAND_LINK, {
          type: 'png', errorCorrectionLevel: 'M', margin: 0, width: Math.max(64, edge), color: { dark: '#000000', light: '#ffffff' },
        });
        const padding = Math.round(edge * (QR_PADDING_RATIO / QR_RATIO));
        // 白底安静区：二维码贴在海报内容上时对比度与可扫率都依赖这圈白边
        return await sharp({ create: { width: edge + padding * 2, height: edge + padding * 2, channels: 4, background: '#ffffff' } })
          .composite([{ input: code, top: padding, left: padding }]).png().toBuffer();
      } catch {
        return null;
      }
    })();
  }
  return qrCache;
}

export interface BrandedPoster {
  bytes: Buffer;
  /** 合成后是否真的贴上了品牌带（关闭开关或失败时为 false） */
  branded: boolean;
}

/**
 * 给海报底部补品牌带与二维码。
 *
 * 尺寸按海报实际宽度等比换算，不假设一定是 1024 宽（生图服务不保证尺寸）。
 * 任何异常都返回原图：品牌带只是附加曝光，不该让用户拿不到海报。
 */
export async function applyShareBrand(bytes: Buffer, style: TripShareStyle): Promise<BrandedPoster> {
  try {
    const meta = await sharp(bytes).metadata();
    if (!meta.width || !meta.height || !meta.format) return { bytes, branded: false };

    const width = meta.width;
    const bandHeight = Math.max(48, Math.round(BAND_HEIGHT * (width / BAND_WIDTH)));
    const band = await loadBand(style, width, bandHeight);

    const composites: OverlayOptions[] = [{ input: band, top: meta.height, left: 0 }];
    const qrEdge = Math.round(width * QR_RATIO);
    const qr = await loadQr(qrEdge);
    if (qr) {
      const qrBox = qrEdge + Math.round(qrEdge * (QR_PADDING_RATIO / QR_RATIO)) * 2;
      composites.push({
        input: qr,
        top: meta.height + Math.round((bandHeight - qrBox) / 2),
        left: width - qrBox - Math.round(width * QR_RIGHT_RATIO),
      });
    }

    const out = await sharp(bytes)
      .extend({ bottom: bandHeight, background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .composite(composites)
      .toFormat(meta.format as keyof FormatEnum)
      .toBuffer();
    return { bytes: out, branded: true };
  } catch {
    return { bytes, branded: false };
  }
}
