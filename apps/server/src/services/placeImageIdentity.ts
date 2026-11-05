import { createPlaceIdentityIndex, placeIdentity, type IdentityPlace } from '../lib/placeIdentity';
import type { StoredImage } from '../lib/imageGallery';
import { filterIdentityImages } from './placeImagePolicy';

/** 旧图片清单沿稳定成员 ID 找到现行主实体，原路径与来源保持不变。 */
export function resolveImageIdentities(city: string, groups: ReadonlyMap<string, StoredImage[]>, places: readonly IdentityPlace[],
  onSkipped?: (id: string) => void) {
  const index = createPlaceIdentityIndex(places);
  const mapped = new Map<string, StoredImage[]>();
  for (const [id, images] of groups) {
    const result = index.resolve(city, '', id);
    if (result.status !== 'resolved' || (placeIdentity(result.place).kind === 'complex' && id !== result.place.id)) {
      onSkipped?.(id);
      continue;
    }
    const accepted = filterIdentityImages(result.place, images);
    if (!accepted.length) {
      onSkipped?.(id);
      continue;
    }
    const previous = mapped.get(result.place.id) ?? [];
    mapped.set(result.place.id, [...new Map([...previous, ...accepted].map(photo => [photo.key, photo])).values()].slice(0, 3));
  }
  return mapped;
}
