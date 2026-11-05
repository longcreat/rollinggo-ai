import { mock } from 'node:test';
import { amapQuotaGate } from '../../integrations/amap/request';
import { amapDay } from '../../integrations/amap/services';

// Adapter tests exercise parsing/caching; admission is covered separately.
mock.method(amapQuotaGate, 'acquire', async (service: import('../../integrations/amap/services').AmapService) => ({
  ...amapDay(), service, allowed: true, used: 1, limit: 1000,
}));
