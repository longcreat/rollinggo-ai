import { useQuery } from '@tanstack/react-query';
import { Value } from '@sinclair/typebox/value';
import { TripWeatherSchema, type Trip, type TripWeather } from '@tripweaver/shared';
import { api, shouldRetryQuery } from './client';
import { keys } from './hooks';

export function useTripWeather(id: string, trip: Trip | undefined) {
  return useQuery({
    queryKey: [...keys.trip(id), 'weather'],
    enabled: Boolean(id && trip),
    queryFn: async ({ signal }): Promise<TripWeather> => {
      const result = await api.get<unknown>(`/api/trips/${encodeURIComponent(id)}/weather`, { signal });
      if (!Value.Check(TripWeatherSchema, result)) throw new Error('天气数据读取失败，请稍后重试');
      return result;
    },
    staleTime: 30 * 60_000,
    refetchOnMount: 'always',
    refetchInterval: 30 * 60_000,
    retry: shouldRetryQuery,
  });
}
