import { pool } from '../db/client';
import { env } from '../env';
import { createAmapQuotaLedger } from '../lib/amapQuotaLedger';

export const amapQuotaLedger = createAmapQuotaLedger(pool, env.amapServiceBudgets);
