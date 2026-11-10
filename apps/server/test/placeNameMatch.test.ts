// 展示层名称关联护栏：2 字名只认精确匹配，避免「西湖」命中「西湖醋鱼」。
// 实体身份判定不在这里（走 placeIdentity.ts 的 samePlaceReference）。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { placeNameContains, placeNameContainsKey } from '@rollinggo-trip/shared';

describe('placeNameContainsKey（调用方已归一化）', () => {
  it('精确相等永远命中，包括 2 字名', () => {
    assert.equal(placeNameContainsKey('西湖', '西湖'), true);
    assert.equal(placeNameContainsKey('宽窄巷子', '宽窄巷子'), true);
  });

  it('2 字名不做包含匹配：西湖 ↛ 西湖醋鱼', () => {
    assert.equal(placeNameContainsKey('西湖', '西湖醋鱼'), false);
    assert.equal(placeNameContainsKey('故宫', '故宫博物院'), false);
  });

  it('≥3 字且长度比不过半时接受包含（东门/西门这类变体）', () => {
    assert.equal(placeNameContainsKey('人民公园', '人民公园东门'), true);
    assert.equal(placeNameContainsKey('宽窄巷子', '宽窄巷子景区'), true);
  });

  it('长度比超过一半时拒绝，避免长尾复合名误配', () => {
    assert.equal(placeNameContainsKey('人民公园', '人民公园东门停车场'), false);
  });

  it('空串不命中', () => {
    assert.equal(placeNameContainsKey('', '西湖'), false);
    assert.equal(placeNameContainsKey('西湖', ''), false);
  });

  it('对称：参数顺序不影响结果', () => {
    assert.equal(placeNameContainsKey('西湖醋鱼', '西湖'), false);
    assert.equal(placeNameContainsKey('人民公园东门', '人民公园'), true);
  });
});

describe('placeNameContains（内部按 placeNameKey 归一化）', () => {
  it('忽略空白与大小写', () => {
    assert.equal(placeNameContains('人民公园', ' 人民公园 东门 '), true);
    assert.equal(placeNameContains('WEST LAKE', 'west lake'), true);
  });

  it('2 字名仍只认精确', () => {
    assert.equal(placeNameContains('西湖', '西湖醋鱼'), false);
  });
});