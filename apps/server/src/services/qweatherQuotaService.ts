import { pool } from '../db/client';
import { env } from '../env';
import { createServiceQuotaLedger } from '../lib/amapQuotaLedger';
import { QWEATHER_SERVICE, qweatherDay } from '../integrations/qweather/client';

export const qweatherQuotaLedger = createServiceQuotaLedger(pool, [QWEATHER_SERVICE], { [QWEATHER_SERVICE]: env.qweatherDailyBudget }, qweatherDay);
