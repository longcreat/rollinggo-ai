import { LEG_MODES, wgs84ToGcj02, type Activity, type RouteOptionsRequest, type RouteOptionsResponse } from '@rollinggo-trip/shared';
import type { GeoProvider } from '@rollinggo-trip/integrations/geoProvider';

export const ROUTE_OPTIONS_MAX_CALLS = 8;

/** Provider calls only; the HTTP/service wrapper owns auth, concurrency and durable quota. */
export async function queryRouteOptions(
  input: RouteOptionsRequest,
  provider: GeoProvider,
  acquire: () => boolean,
  modes = input.mode ? [input.mode] : [...LEG_MODES],
): Promise<RouteOptionsResponse> {
  const unavailable = (reason: string): RouteOptionsResponse => ({
    options: modes.map((mode) => ({ status: 'unavailable', mode, reason })),
  });
  if (input.from.id === input.to.id) return unavailable('请选择两个不同地点');
  if ([input.from, input.to].some((a) => (a.lat === 0 && a.lng === 0))) return unavailable('地点缺少坐标');
  if (!provider.enabled || provider.kind === 'null') return unavailable('尚未配置路线服务');
  const point = (a: Activity) => a.coordSystem === 'gcj02' ? { lat: a.lat, lng: a.lng } : wgs84ToGcj02(a.lat, a.lng);
  const breaker = provider.createRouteBreaker();
  const options: RouteOptionsResponse['options'] = [];
  for (const mode of modes) {
    let city1: string | undefined;
    let city2: string | undefined;
    if (mode === 'transit') {
      city1 = (await provider.geocodeActivity(input.from.name, input.destination, acquire))?.adcode;
      city2 = (await provider.geocodeActivity(input.to.name, input.destination, acquire))?.adcode;
      if (!city1 || !city2) {
        options.push({ status: 'unavailable', mode, reason: '暂未识别地点所属城市，请重试' });
        continue;
      }
    }
    const estimate = await breaker.estimate(point(input.from), point(input.to), mode, { city1, city2 }, acquire);
    options.push(estimate ? {
      status: 'available', leg: { ...estimate, mode, source: provider.kind,
        fromActivityId: input.from.id, toActivityId: input.to.id },
    } : { status: 'unavailable', mode, reason: '暂未获得路线，可能不可达或服务暂不可用' });
  }
  return { options };
}
