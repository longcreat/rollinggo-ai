import { type RouteOptionsResponse, type TransitLeg } from '@tripweaver/shared';

/** Prefer a real walk of at most 1 km, otherwise the fastest available route. */
export function recommendedRoute(options: RouteOptionsResponse['options']): TransitLeg | undefined {
  const legs = options.flatMap((option) => option.status === 'available' && option.leg.source !== 'heuristic' ? [option.leg] : []);
  const walk = legs.find((leg) => leg.mode === 'walk' && leg.distanceM <= 1000);
  const order = ['walk', 'cycle', 'transit', 'drive'];
  return walk ?? legs.sort((a, b) => a.durationMin - b.durationMin || a.distanceM - b.distanceM || order.indexOf(a.mode) - order.indexOf(b.mode))[0];
}
