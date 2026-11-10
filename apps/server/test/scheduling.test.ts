// 单测：候选热度评分（scheduling/score.ts，retrievalRanking 的底座，node:test 经 tsx 运行）。
// 旧确定性排程（buildSchedule）已由 planner/ 编排 Agent 接管，相关用例随之移除。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEUTRAL_RATIO, poiScore, scoreMaxima } from '@rollinggo-trip/agent/generation/scheduling/score';

test('选点权重：缺失分走中性（不当 0），金集另有加分', () => {
  const maxima = { score: 50, mention: 20 };
  assert.equal(poiScore({ recommendScore: 50, mentionCount: 20, source: 'xhs' }, maxima), 100);
  // 分数全缺：质量/热度各取中性 0.5，金集再加 15
  assert.equal(poiScore({ source: 'goldset' }, maxima), NEUTRAL_RATIO * 60 + NEUTRAL_RATIO * 40 + 15);
  assert.equal(poiScore({ source: 'xhs' }, maxima), NEUTRAL_RATIO * 60 + NEUTRAL_RATIO * 40);
  assert.equal(poiScore(undefined, maxima), NEUTRAL_RATIO * 60 + NEUTRAL_RATIO * 40);
  // 金集地标（无分数）必须排在同为无数据的普通点前面 —— 修的就是这个反转
  assert.ok(poiScore({ source: 'goldset' }, maxima) > poiScore({ source: 'xhs' }, maxima));
  // 金集自带分数时，和同样有分的点比仍然是「金集优先」
  assert.ok(poiScore({ recommendScore: 40, source: 'goldset' }, maxima) > poiScore({ recommendScore: 40, source: 'xhs' }, maxima));
});

test('归一化基准只统计有值样本，缺失值不拉低整体', () => {
  assert.deepEqual(scoreMaxima([{ recommendScore: 10, mentionCount: 2 }, { source: 'goldset' }]), {
    score: 10,
    mention: 2,
  });
  assert.deepEqual(scoreMaxima([{ source: 'goldset' }, undefined]), { score: 0, mention: 0 });
});
