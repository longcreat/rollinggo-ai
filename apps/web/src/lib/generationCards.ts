import type { ResearchPoi } from '@tripweaver/shared';

/** Keep recent usable photos ahead of empty/failed covers without discarding candidate data. */
export function selectGenerationCards(pois: readonly ResearchPoi[], failedUrls: ReadonlySet<string>, limit = 5): ResearchPoi[] {
  const withPhoto = pois.filter(poi => poi.coverUrl && !failedUrls.has(poi.coverUrl));
  const selected = withPhoto.slice(-limit);
  if (selected.length < limit) {
    const withoutPhoto = pois.filter(poi => !poi.coverUrl || failedUrls.has(poi.coverUrl));
    selected.push(...withoutPhoto.slice(-(limit - selected.length)));
  }
  const ids = new Set(selected.map(poi => poi.id));
  return pois.filter(poi => ids.has(poi.id));
}

/** Keep the photo label focused on the place; descriptions belong in the itinerary. */
export function generationCardCaption(poi: ResearchPoi): string {
  return poi.name;
}

/** Change at most one slot per tick; keep the others stable while a newer target arrives. */
export function advanceGenerationCards(current: ResearchPoi[], target: ResearchPoi[]): ResearchPoi[] {
  const incoming = target.find(poi => !current.some(shown => shown.id === poi.id && shown.coverUrl === poi.coverUrl));
  const staleIndex = current.findIndex(poi => !target.some(wanted => wanted.id === poi.id && wanted.coverUrl === poi.coverUrl));
  // 候选池按“最近 5 张”滚动，已展示的卡片会随时掉出 target；未填满前只追加，
  // 否则每来一个新候选就把唯一那张换掉，画面永远只有第一张。
  if (incoming && current.length < target.length) return [...current, incoming];
  if (incoming) {
    if (staleIndex >= 0) return current.map((poi, i) => i === staleIndex ? incoming : poi);
    return [...current, incoming];
  }
  if (staleIndex >= 0) return current.filter((_, i) => i !== staleIndex);
  return current;
}
