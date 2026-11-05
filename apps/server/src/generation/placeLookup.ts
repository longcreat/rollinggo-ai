import type { Activity, ResearchPoi } from '@tripweaver/shared';
import type { GeocodedPoint } from '../integrations/geoContracts';

/** Generation-only hints. They are stripped when DraftTrip becomes a persisted Trip. */
export interface PlaceHint {
  placeName?: string;
  poiId?: string;
}

export type DraftActivity = Activity & PlaceHint;
export type ResearchLocation = Readonly<GeocodedPoint>;

export function isUsableResearchLocation(point: ResearchLocation): boolean {
  return Number.isFinite(point.lat) && Number.isFinite(point.lng)
    && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180
    && (point.lat !== 0 || point.lng !== 0);
}

/** Exact names only: distinct same-name results must go through normal disambiguation. */
export function rememberResearchLocation(
  locations: Map<string, ResearchLocation>,
  ambiguousNames: Set<string>,
  name: string,
  point: ResearchLocation,
): void {
  const key = name.trim();
  if (!key || ambiguousNames.has(key) || !isUsableResearchLocation(point)) return;
  const previous = locations.get(key);
  if (previous && (previous.lat !== point.lat || previous.lng !== point.lng
    || (previous.adcode && point.adcode && previous.adcode !== point.adcode))) {
    locations.delete(key);
    ambiguousNames.add(key);
    return;
  }
  locations.set(key, { lat: point.lat, lng: point.lng, adcode: point.adcode || previous?.adcode || '' });
}

/** Legacy meal display names contain an area followed by cuisine, not a business name. */
export function activityPlaceName(activity: Pick<Activity, 'name'> & PlaceHint): string {
  const explicit = activity.placeName?.trim();
  if (explicit) return explicit;
  const name = activity.name.trim();
  const meal = /^(?:午餐|午饭|中餐|晚餐|晚饭|早餐)\s*[｜|：:]\s*([^·•｜|]+)(?:[·•｜|].*)?$/.exec(name);
  return meal?.[1]?.trim() || name;
}

export interface PlaceLookupResult {
  name: string;
  point?: ResearchLocation;
}

export function createResearchPlaceLookup(
  pool: readonly Pick<ResearchPoi, 'id' | 'name'>[],
  locations: ReadonlyMap<string, ResearchLocation>,
): (activity: Pick<Activity, 'name'> & PlaceHint) => PlaceLookupResult {
  const candidateNames = new Map(pool.map((poi) => [poi.id, poi.name.trim()]));
  return (activity) => {
    const query = activityPlaceName(activity);
    const candidateName = activity.poiId ? candidateNames.get(activity.poiId) : undefined;
    // An explicit place change wins over an old/mismatched candidate reference.
    const name = candidateName && (!activity.placeName?.trim() || activity.placeName.trim() === candidateName)
      ? candidateName
      : query;
    const point = locations.get(name);
    return { name, ...(point && isUsableResearchLocation(point) ? { point } : {}) };
  };
}
