import { mock } from 'node:test';
import { amapQuotaGate } from '@tripweaver/integrations/amap/request';
import { amapDay } from '@tripweaver/core/amapServices';

// Adapter tests exercise parsing/caching; admission is covered separately.
mock.method(amapQuotaGate, 'acquire', async (service: import('@tripweaver/core/amapServices').AmapService) => ({
  ...amapDay(), service, allowed: true, used: 1, limit: 1000,
}));
