import { identityStrings } from './placeIdentity';

export function placeEmbeddingText(place: { city: string; name: string; category?: string; payload?: Record<string, unknown> | null }): string {
  const identity = place.payload?.identity as Record<string, unknown> | undefined;
  const names = [...new Set([place.name, ...identityStrings(place.payload?.aliases), ...identityStrings(identity?.memberNames)])];
  return `${place.city} ${names.join(' ')} ${place.category ?? ''}`.trim();
}
