// 离线图片清单与库内三图契约；来源审核记录留在 payload，展示只读取已校验字段。
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { PhotoAttributionSchema } from '@tripweaver/shared';

export const StoredImageSchema = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 240 }),
  attribution: Type.Optional(PhotoAttributionSchema),
  provenance: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type StoredImage = Static<typeof StoredImageSchema>;

export function safeImageKey(key: string): boolean {
  return /^[\p{L}\p{N}_/.-]+\.webp$/u.test(key) && !key.split('/').some(part => !part || part === '.' || part === '..');
}

export function readImageGallery(value: unknown): StoredImage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((image): image is StoredImage => Value.Check(StoredImageSchema, image) && safeImageKey(image.key)).slice(0, 3);
}

const EntrySchema = Type.Object({
  placeId: Type.String({ minLength: 1, maxLength: 128 }),
  key: Type.String({ minLength: 1, maxLength: 240 }),
  sourceUrl: Type.Optional(Type.String({ maxLength: 1500 })),
  author: Type.Optional(Type.String({ maxLength: 300 })),
  rights: Type.Optional(Type.String()),
  reviewMethod: Type.Optional(Type.String()),
  review: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export function imageGroups(value: unknown, limit = 3): Map<string, StoredImage[]> {
  if (!Array.isArray(value)) throw new Error('图片清单 images 必须为数组');
  const groups = new Map<string, StoredImage[]>();
  for (const entry of value) {
    if (!Value.Check(EntrySchema, entry) || !safeImageKey(entry.key)) throw new Error('图片清单含无效地点或媒体路径');
    const image: StoredImage = { key: entry.key, provenance: { ...entry } };
    if (entry.key.startsWith('xhs/photography/')) {
      if (entry.reviewMethod !== 'model' || entry.review?.status !== 'eligible' || entry.review?.identity !== 'match'
          || !entry.sourceUrl || !/^https:\/\/www\.xiaohongshu\.com\/explore\/[a-zA-Z0-9]+$/.test(entry.sourceUrl)) {
        throw new Error('摄影精选缺少有效模型审核或来源');
      }
      image.attribution = {
        source: 'xhs', photographer: entry.author || '原笔记作者', sourceUrl: entry.sourceUrl,
        license: '未确认授权', licenseUrl: entry.sourceUrl, changes: '等比缩放、转码；模型审核',
      };
    }
    const group = groups.get(entry.placeId) ?? [];
    if (group.length < limit && !group.some(old => old.key === image.key)) group.push(image);
    groups.set(entry.placeId, group);
  }
  return groups;
}
