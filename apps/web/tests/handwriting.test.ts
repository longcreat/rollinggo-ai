import assert from 'node:assert/strict';
import test from 'node:test';
import { handwritingFallback } from '../src/lib/handwriting';

test('原缺字标题与照片题字保留悠然小楷，标点符号不使整句失去手写体', () => {
  for (const text of ['中轴宫苑漫步', '苑麓雍颐榭锣祈簋', '故宫 · 角楼黄昏', '正在寻找颐和园的风景…', '北京 🌄']) {
    assert.equal(handwritingFallback(text), undefined);
  }
});

test('未收录的汉字和扩展区字符让整段采用备用字体，不改变原文', () => {
  for (const text of ['古罍听风', '𠮷野漫步']) {
    assert.equal(handwritingFallback(text)?.fontFamily, "'Noto Serif SC Variable', SimSun, serif");
  }
});
