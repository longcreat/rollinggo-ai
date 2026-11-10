import { mock } from 'node:test';
import { amapQuotaGate } from '@rollinggo-trip/integrations/amap/request';
import { amapDay } from '@rollinggo-trip/core/amapServices';

// Adapter tests exercise parsing/caching; admission is covered separately.
mock.method(amapQuotaGate, 'acquire', async (service: import('@rollinggo-trip/core/amapServices').AmapService) => ({
  ...amapDay(), service, allowed: true, used: 1, limit: 1000,
}));
