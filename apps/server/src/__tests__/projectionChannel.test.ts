// 投影信道：水位分配连续；重订阅要么补增量、要么整体重发快照，绝不猜。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptySnapshot, type ProjectionDelta } from '@tripweaver/shared';
import { ProjectionChannel } from '../generation/projectionChannel';

type Row = { rowId: number; label: string };
type State = { phase: string };

const channel = (limit = 4) => new ProjectionChannel<Row, State>(emptySnapshot({ phase: 'idle' }), limit);

const append = (rowId: number): ProjectionDelta<Row, State> => ({ op: 'row.appended', row: { rowId, label: `d${rowId}` } });

describe('ProjectionChannel', () => {
  it('publish 分配连续水位并应用到快照', () => {
    const ch = channel();
    const first = ch.publish(append(1));
    const second = ch.publish({ op: 'state.updated', patch: { phase: 'plan' } });
    assert.deepEqual([first.fromSeq, first.toSeq], [0, 1]);
    assert.deepEqual([second.fromSeq, second.toSeq], [1, 2]);
    assert.equal(ch.snapshot.seq, 2);
    assert.equal(ch.snapshot.state.phase, 'plan');
    assert.deepEqual(ch.snapshot.rows.window.map((row) => row.rowId), [1]);
  });

  it('首次订阅（水位 0）即使缓冲从 0 开始也给快照：增量必须有基线才能应用', () => {
    const ch = channel();
    ch.publish(append(1));
    ch.publish(append(2));
    const resumed = ch.resume(0);
    assert.equal(resumed.kind, 'snapshot');
    if (resumed.kind !== 'snapshot') return;
    assert.equal(resumed.snapshot.seq, 2);
    assert.deepEqual(resumed.snapshot.rows.window.map((row) => row.rowId), [1, 2]);
  });

  it('水位一致时无需补发', () => {
    const ch = channel();
    ch.publish(append(1));
    assert.deepEqual(ch.resume(1), { kind: 'delta', frames: [] });
  });

  it('缓冲窗口内的重订阅只补缺失增量', () => {
    const ch = channel();
    ch.publish(append(1));
    ch.publish(append(2));
    ch.publish(append(3));
    const resumed = ch.resume(1);
    assert.equal(resumed.kind, 'delta');
    if (resumed.kind !== 'delta') return;
    assert.deepEqual(resumed.frames.map((frame) => frame.fromSeq), [1, 2]);
  });

  it('落后超过缓冲窗口时整体重发快照', () => {
    const ch = channel(2);
    ch.publish(append(1));
    ch.publish(append(2));
    ch.publish(append(3));
    const resumed = ch.resume(0);
    assert.equal(resumed.kind, 'snapshot');
    if (resumed.kind !== 'snapshot') return;
    assert.equal(resumed.snapshot.seq, 3);
    assert.deepEqual(resumed.snapshot.rows.window.map((row) => row.rowId), [1, 2, 3]);
  });

  it('水位超前（客户端比服务端新）按快照处理，不做猜测', () => {
    const ch = channel();
    ch.publish(append(1));
    assert.equal(ch.resume(9).kind, 'snapshot');
  });
});