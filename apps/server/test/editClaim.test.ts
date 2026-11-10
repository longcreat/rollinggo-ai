import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimsUnappliedEdit, withEditCorrection } from '@tripweaver/agent/chat/agent/editClaim';

test('没有写操作时，完成时表述判为未落地', () => {
  assert.equal(claimsUnappliedEdit('第 1 天的时间安排，我已修好两处关键问题。', false), true);
  assert.equal(claimsUnappliedEdit('晚餐已经换成园区外的火锅。', false), true);
  assert.equal(claimsUnappliedEdit('现在的时间线已经重排好了。', false), true);
  assert.equal(claimsUnappliedEdit('已为你生成新的行程。', false), true);
});

test('确有改动或生成新行程时不再纠正', () => {
  assert.equal(claimsUnappliedEdit('已改好两处。', true), false);
});

test('只读问答与明确说明未修改不触发', () => {
  assert.equal(claimsUnappliedEdit('第 1 天上午熊猫基地，下午回市区。', false), false);
  assert.equal(claimsUnappliedEdit('目前还没有修改，需要我直接改吗？', false), false);
  // 异步委派的正确措辞：已开始 ≠ 已完成
  assert.equal(claimsUnappliedEdit('已在后台开始生成，稍后可以在任务页查看进度。', false), false);
});

test('纠正保留原文并明确说明未修改', () => {
  const fixed = withEditCorrection('已改好两处。');
  assert.match(fixed, /^已改好两处。/);
  assert.match(fixed, /没有实际修改或生成行程/);
});
