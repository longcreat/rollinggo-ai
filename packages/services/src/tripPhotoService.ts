import type { ResearchPoi, Trip } from '@tripweaver/shared';

type AmapPhotoCover = Pick<ResearchPoi, 'coverUrl' | 'photos'>;

/**
 * 只补详情响应中的空图片，不写回历史版本。
 * lookup 只返回高德 POI 图（库内 `payload.amapPhoto`），读路径零外呼、零配额。
 */
export async function enrichTripPhotos(trip: Trip, lookup: (name: string) => Promise<AmapPhotoCover | null>): Promise<Trip> {
  if (!trip.overview?.length) return trip;
  const pending = new Map<string, Promise<AmapPhotoCover | null>>();
  const overview = await Promise.all(trip.overview.map(async poi => {
    if (poi.category !== 'attraction' || poi.coverUrl || poi.photos?.length) return poi;
    let result = pending.get(poi.name);
    if (!result) {
      result = lookup(poi.name).catch(() => null);
      pending.set(poi.name, result);
    }
    const cover = await result;
    return cover?.coverUrl ? { ...poi, ...cover } : poi;
  }));
  return { ...trip, overview };
}
