// 目的地路由（09-26 城市选择首页）：已覆盖城市列表，供首页城市图集渲染
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { CoveredCitiesView } from '@tripweaver/shared';
import { listCoveredCities } from '../services/cityCoverageService';

export const destinationRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // 首页访客只读取公开城市名称；行程和生成路由仍独立鉴权。

  app.get('/covered', async (): Promise<CoveredCitiesView> => ({ cities: await listCoveredCities() }));
};
