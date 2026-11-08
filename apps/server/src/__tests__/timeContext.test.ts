import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCurrentTimeContext, withTimeContext } from '../chat/agent/timeContext';

describe('timeContext 实时时间上下文', () => {
  it('生成结构化的 <current_time> 块', () => {
    const fixed = new Date('2026-11-08T22:48:00+08:00');
    const ctx = buildCurrentTimeContext(fixed);

    assert.ok(ctx.includes('<current_time>'));
    assert.ok(ctx.includes('</current_time>'));
    assert.ok(ctx.includes('当前日期：2026-11-08（星期日）'));
    assert.ok(ctx.includes('当前时间：22:48（中国标准时间 UTC+8）'));
    assert.ok(ctx.includes('明天 2026-11-09'));
    assert.ok(ctx.includes('后天 2026-11-10'));
    assert.ok(ctx.includes('下个周末为 2026-11-14（六）~ 2026-11-15（日）'));
  });

  it('周三时正确推算本周末', () => {
    const wednesday = new Date('2026-11-04T10:00:00+08:00');
    const ctx = buildCurrentTimeContext(wednesday);

    assert.ok(ctx.includes('当前日期：2026-11-04（星期三）'));
    assert.ok(ctx.includes('本周末为 2026-11-07（六）~ 2026-11-08（日）'));
  });

  it('withTimeContext 严格将时间追加在指令最末尾以最大化命中前缀缓存', () => {
    const base = '你是旅行助手。以下是核心工具规则...';
    const result = withTimeContext(base, new Date('2026-11-08T12:00:00+08:00'));

    assert.ok(result.startsWith(base));
    assert.ok(result.endsWith('</current_time>'));
    // 前缀完全未被修改
    assert.equal(result.indexOf(base), 0);
  });
});
