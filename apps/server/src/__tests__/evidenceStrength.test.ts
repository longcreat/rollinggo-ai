import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evidenceStrength } from '../services/evidenceStrength';

test('语料强度：上游值优先，无来源的预约/价格不顶格', () => {
  assert.equal(evidenceStrength({ kind: 'xhs_reservation', sourceUrl: 'https://example.com/a' }), 'direct');
  assert.equal(evidenceStrength({ kind: 'xhs_reservation' }), 'weak');
  assert.equal(evidenceStrength({ kind: 'xhs_price', sourceUrl: '' }), 'weak');
  assert.equal(evidenceStrength({ kind: 'xhs_price', sourceUrl: '', strength: 'direct' }), 'direct');
  assert.equal(evidenceStrength({ kind: 'xhs_warning', sourceUrl: 'https://example.com/b' }), 'risk_only');
  assert.equal(evidenceStrength({ kind: 'xhs_reason' }), 'weak');
  assert.equal(evidenceStrength({ kind: 'xhs_reason', strength: 'strong' }), 'strong');
  assert.equal(evidenceStrength({ kind: 'xhs_other', sourceUrl: 'https://example.com/c' }), 'direct');
});
