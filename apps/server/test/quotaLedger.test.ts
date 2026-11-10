import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { createServiceQuotaLedger } from '@rollinggo-trip/core/lib/amapQuotaLedger';
import { amapDay } from '@rollinggo-trip/core/amapServices';

/** 只模拟两种 SQL 的语义：带阈值的原子扣减、以及只增不减的计数。 */
function fakePool() {
  const calls = new Map<string, number>();
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      const [, service, limit] = params as [string, string, number?];
      if (sql.includes('INSERT INTO amap_service_usage')) {
        const current = calls.get(service) ?? 0;
        if (sql.includes('amap_service_usage.calls < $3') && current >= (limit ?? 0)) return { rows: [] };
        const next = current + 1;
        calls.set(service, next);
        return { rows: [{ calls: next }] };
      }
      if (sql.includes('SELECT service, calls')) {
        return { rows: [...calls].map(([name, n]) => ({ service: name, calls: n })) };
      }
      if (sql.includes('SELECT calls')) return { rows: calls.has(service) ? [{ calls: calls.get(service) }] : [] };
      return { rows: [] };
    },
  };
  return { calls, pool: pool as unknown as Pick<Pool, 'query'> };
}

test('enforcement defaults on: over-limit calls are rejected and not charged', async () => {
  const { calls, pool } = fakePool();
  const ledger = createServiceQuotaLedger(pool, ['place'], { place: 2 }, amapDay);
  assert.equal((await ledger.acquire('place')).allowed, true);
  assert.equal((await ledger.acquire('place')).allowed, true);
  const blocked = await ledger.acquire('place');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.used, 2);
  assert.equal(calls.get('place'), 2);
  assert.equal(await ledger.remainingOf('place'), 0);
  assert.equal(await ledger.remaining(), 0);
});

test('meter-only mode never blocks and keeps counting past the budget', async () => {
  const { calls, pool } = fakePool();
  const ledger = createServiceQuotaLedger(pool, ['place'], { place: 2 }, amapDay, Date.now, { enforce: false });
  for (let index = 0; index < 4; index += 1) {
    const decision = await ledger.acquire('place');
    assert.equal(decision.allowed, true);
    assert.equal(decision.used, index + 1);
    assert.equal(decision.limit, 2);
  }
  assert.equal(calls.get('place'), 4);
  assert.equal(await ledger.remainingOf('place'), Number.POSITIVE_INFINITY);
  assert.equal(await ledger.remaining(), Number.POSITIVE_INFINITY);
});