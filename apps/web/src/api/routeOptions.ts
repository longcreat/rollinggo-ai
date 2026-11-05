import { useEffect, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Value } from '@sinclair/typebox/value';
import { LEG_MODES, RouteOptionsResponseSchema, type LegMode, type RouteOptionsRequest, type RouteOptionsResponse } from '@tripweaver/shared';
import { api, ApiError } from './client';
import { useMe } from './hooks';
import { RouteQueryQueue } from '../lib/routeQueryQueue';

const queue = new RouteQueryQueue();
let cooldownUntil = 0;
const ttl = (option?: RouteOptionsResponse['options'][number]) => option?.status === 'available' ? 5 * 60_000 : 30_000;

export function useRouteOptions(pairKey: string, tripId: string, input: RouteOptionsRequest, enabled: boolean) {
  const client = useQueryClient();
  const userId = useMe().data?.id ?? '';
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 350);
    return () => clearTimeout(timer);
  }, []);

  const options = (mode: LegMode, refresh = false) => {
    const queryKey = ['route-options', userId, pairKey, mode] as const;
    return {
      queryKey,
      queryFn: ({ signal }: { signal: AbortSignal }) => queue.enqueue(JSON.stringify(queryKey), signal, async () => {
        if (Date.now() < cooldownUntil) throw new Error('路线查询暂不可用，请稍后重试');
        try {
          const response = await api.post<unknown>(`/api/trips/${encodeURIComponent(tripId)}/route-options`, { ...input, mode, refresh });
          if (!Value.Check(RouteOptionsResponseSchema, response) || response.options.length !== 1) throw new Error('路线数据格式异常，请重试');
          const option = response.options[0]!;
          if ((option.status === 'available' ? option.leg.mode : option.mode) !== mode) throw new Error('路线方式不匹配，请重试');
          return option;
        } catch (error) {
          if (error instanceof ApiError && error.status === 429) cooldownUntil = Date.now() + 30_000;
          throw error;
        }
      }),
      retry: false as const,
      gcTime: 30 * 60_000,
      refetchOnWindowFocus: false,
    };
  };
  const queries = useQueries({ queries: LEG_MODES.map((mode) => ({
    ...options(mode),
    enabled: enabled && ready && Boolean(userId),
    staleTime: (query: { state: { data?: RouteOptionsResponse['options'][number] } }) => ttl(query.state.data),
  })) });

  async function get(mode: LegMode, refresh = false) {
    const config = options(mode, refresh);
    const state = client.getQueryState(config.queryKey);
    const data = client.getQueryData<RouteOptionsResponse['options'][number]>(config.queryKey);
    const promise = client.fetchQuery({ ...config, staleTime: refresh ? 0 : ttl(data) });
    queue.promote(JSON.stringify(config.queryKey));
    // Newly created fetch work is also promoted after its queryFn enters the queue.
    if (!state) queueMicrotask(() => queue.promote(JSON.stringify(config.queryKey)));
    return promise;
  }
  return { queries, get };
}
