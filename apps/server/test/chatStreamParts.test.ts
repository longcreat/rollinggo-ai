import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reduceStreamParts, type StreamParts } from '../../../apps/web/src/lib/chatStreamParts';
import type { ChatStreamEvent } from '@tripweaver/shared';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

describe('reduceStreamParts', () => {
  it('多轮工具调用时保持思考与正文完整独立，不截断', () => {
    let state: StreamParts = { parts: [], textOpen: false };

    let seq = 1;
    const feed = (event: DistributiveOmit<ChatStreamEvent, 'requestId' | 'sequence'>) => {
      const fullEvent = { ...event, requestId: 'req-1', sequence: seq++ } as ChatStreamEvent;
      const next = reduceStreamParts(state, fullEvent);
      if (next) state = next;
    };

    // 1. Turn 1 思考
    feed({ type: 'thinking_start' });
    feed({ type: 'thinking_delta', text: '这次改用新闻频道检索。' });
    feed({ type: 'thinking_end' });

    // 2. Turn 1 正文流式初期
    feed({ type: 'answer_delta', text: '我先', replace: true });
    // Turn 1 工具触发前 flush 的完整正文快照
    feed({ type: 'answer_delta', text: '我先看一下你现在的第 1 天怎么排的，再对照主流路线。', replace: true });

    // 3. Turn 1 工具触发
    feed({
      type: 'progress',
      text: '正在查看行程…',
      step: { id: 'call-1', name: 'get_day', label: '查看行程', status: 'running', startedAt: 100 },
    });
    feed({
      type: 'progress',
      text: '查看行程完成',
      step: { id: 'call-1', name: 'get_day', label: '查看行程', status: 'done', durationMs: 20 },
    });

    // 4. Turn 2 思考（完整文本，无切片）
    feed({ type: 'thinking_start' });
    feed({ type: 'thinking_delta', text: '用户问"查一下杭州一日游路线"。现在给出对照：' });
    feed({ type: 'thinking_end' });

    // 5. Turn 2 最终回答正文
    feed({ type: 'answer_delta', text: '现状路线 vs 主流推荐路线。', replace: true });

    assert.equal(state.parts.length, 5, '应该产生 5 个有序 Block');
    assert.equal(state.parts[0]?.type, 'thinking');
    if (state.parts[0]?.type === 'thinking') {
      assert.equal(state.parts[0].thinking, '这次改用新闻频道检索。');
    }

    assert.equal(state.parts[1]?.type, 'text');
    if (state.parts[1]?.type === 'text') {
      assert.equal(state.parts[1].text, '我先看一下你现在的第 1 天怎么排的，再对照主流路线。', '第一段正文绝不能残留为我先');
    }

    assert.equal(state.parts[2]?.type, 'steps');
    assert.equal(state.parts[3]?.type, 'thinking');
    if (state.parts[3]?.type === 'thinking') {
      assert.equal(state.parts[3].thinking, '用户问"查一下杭州一日游路线"。现在给出对照：', '第二轮思考绝不能被切掉开头');
    }

    assert.equal(state.parts[4]?.type, 'text');
    if (state.parts[4]?.type === 'text') {
      assert.equal(state.parts[4].text, '现状路线 vs 主流推荐路线。');
    }
  });
});
