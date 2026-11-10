// 投影协议：apply / coalesce 语义与黄金不变量（照抄 zcode zcode-protocol-v4）。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyFrames,
  coalesceDeltas,
  coalesceFrames,
  emptySnapshot,
  isContiguous,
  reduceProjectionMessage,
  tripFromProjection,
  type ProjectionDelta,
  type ProjectionFrame,
  type ProjectionSnapshot,
  type TripProjectionSnapshot,
} from '@tripweaver/shared';

type Row = { rowId: number; label: string; text?: string };
type State = { trip: { days: string[] }; cursor: number; phase: string };

const base = (): ProjectionSnapshot<Row, State> => emptySnapshot({ trip: { days: [] }, cursor: 0, phase: 'idle' });

function frames(deltas: ProjectionDelta<Row, State>[], startSeq = 0): ProjectionFrame<Row, State>[] {
  return deltas.map((delta, index) => ({ fromSeq: startSeq + index, toSeq: startSeq + index + 1, delta }));
}

describe('apply 语义', () => {
  it('row.appended 追加并维护 firstRowId/totalCount', () => {
    const snapshot = applyFrames(base(), frames([
      { op: 'row.appended', row: { rowId: 1, label: 'd1' } },
      { op: 'row.appended', row: { rowId: 2, label: 'd2' } },
    ]));
    assert.deepEqual(snapshot.rows.window.map((row) => row.rowId), [1, 2]);
    assert.equal(snapshot.rows.firstRowId, 1);
    assert.equal(snapshot.rows.totalCount, 2);
    assert.equal(snapshot.seq, 2);
  });

  it('row.upserted 只替换已加载行，未加载行 no-op', () => {
    const snapshot = applyFrames(base(), frames([
      { op: 'row.appended', row: { rowId: 1, label: 'd1' } },
      { op: 'row.upserted', row: { rowId: 1, label: 'd1-改' } },
      { op: 'row.upserted', row: { rowId: 99, label: '不存在' } },
    ]));
    assert.equal(snapshot.rows.window[0]!.label, 'd1-改');
    assert.equal(snapshot.rows.window.length, 1);
  });

  it('row.removed 删除该行及之后；从首行裁剪会清零分页锚点', () => {
    const snapshot = applyFrames(base(), frames([
      { op: 'row.appended', row: { rowId: 1, label: 'd1' } },
      { op: 'row.appended', row: { rowId: 2, label: 'd2' } },
      { op: 'row.appended', row: { rowId: 3, label: 'd3' } },
      { op: 'row.removed', fromRowId: 2 },
    ]));
    assert.deepEqual(snapshot.rows.window.map((row) => row.rowId), [1]);
    assert.equal(snapshot.rows.totalCount, 1);
  });

  it('row.delta 只追加流式行，缺失行 no-op', () => {
    const snapshot = applyFrames(base(), frames([
      { op: 'row.appended', row: { rowId: 1, label: 'd1' } },
      { op: 'row.delta', rowId: 1, path: 'text', append: '上午' },
      { op: 'row.delta', rowId: 1, path: 'text', append: '游览' },
      { op: 'row.delta', rowId: 7, path: 'text', append: 'x' },
    ]));
    assert.equal(snapshot.rows.window[0]!.text, '上午游览');
  });

  it('state.updated 键级整体替换，绝不深合并', () => {
    const snapshot = applyFrames(base(), frames([
      { op: 'state.updated', patch: { trip: { days: ['a'] } } },
      { op: 'state.updated', patch: { trip: { days: ['b'] }, phase: 'plan' } },
    ]));
    assert.deepEqual(snapshot.state.trip, { days: ['b'] });
    assert.equal(snapshot.state.phase, 'plan');
  });

  it('isContiguous 要求区间衔接', () => {
    const snapshot = applyFrames(base(), frames([{ op: 'row.appended', row: { rowId: 1, label: 'd1' } }]));
    assert.equal(isContiguous(snapshot, { fromSeq: snapshot.seq }), true);
    assert.equal(isContiguous(snapshot, { fromSeq: snapshot.seq + 1 }), false);
  });
});

describe('coalesce 语义', () => {
  it('相邻同 (rowId,path) 的 row.delta 拼接', () => {
    const coalesced = coalesceDeltas<Row, State>([
      { op: 'row.delta', rowId: 1, path: 'text', append: 'a' },
      { op: 'row.delta', rowId: 1, path: 'text', append: 'b' },
    ]);
    assert.deepEqual(coalesced, [{ op: 'row.delta', rowId: 1, path: 'text', append: 'ab' }]);
  });

  it('upserted 吞掉同行更早的 row.delta', () => {
    const coalesced = coalesceDeltas<Row, State>([
      { op: 'row.appended', row: { rowId: 1, label: 'd1' } },
      { op: 'row.delta', rowId: 1, path: 'text', append: 'a' },
      { op: 'row.upserted', row: { rowId: 1, label: 'd1-改' } },
    ]);
    assert.deepEqual(coalesced.map((delta) => delta.op), ['row.appended', 'row.upserted']);
  });

  it('row.removed 是屏障：不得与前后同行的追加合并', () => {
    const coalesced = coalesceDeltas<Row, State>([
      { op: 'row.delta', rowId: 1, path: 'text', append: 'a' },
      { op: 'row.removed', fromRowId: 1 },
      { op: 'row.delta', rowId: 1, path: 'text', append: 'b' },
      { op: 'row.delta', rowId: 1, path: 'text', append: 'c' },
    ]);
    assert.deepEqual(coalesced.map((delta) => delta.op), ['row.delta', 'row.removed', 'row.delta']);
    assert.deepEqual(coalesced[2], { op: 'row.delta', rowId: 1, path: 'text', append: 'bc' });
  });
});

describe('黄金不变量：applyFrames(s, coalesceFrames(fs)) === applyFrames(s, fs)', () => {
  // 确定性伪随机序列：覆盖 appended / delta / upserted / removed / state 的混合顺序。
  function sequence(seed: number, length: number): ProjectionDelta<Row, State>[] {
    let value = seed >>> 0;
    const next = () => {
      value = (value * 1664525 + 1013904223) >>> 0;
      return value / 0x1_0000_0000;
    };
    let nextRowId = 1;
    const deltas: ProjectionDelta<Row, State>[] = [];
    for (let i = 0; i < length; i += 1) {
      const roll = next();
      if (roll < 0.35) {
        deltas.push({ op: 'row.appended', row: { rowId: nextRowId, label: `d${nextRowId}` } });
        nextRowId += 1;
      } else if (roll < 0.55) {
        deltas.push({ op: 'row.delta', rowId: Math.max(1, nextRowId - 1), path: 'text', append: 'x' });
      } else if (roll < 0.72) {
        deltas.push({ op: 'row.upserted', row: { rowId: Math.max(1, nextRowId - 1), label: '改' } });
      } else if (roll < 0.85) {
        deltas.push({ op: 'state.updated', patch: next() < 0.5 ? { phase: `p${i}` } : { cursor: i } });
      } else if (roll < 0.93) {
        deltas.push({ op: 'row.removed', fromRowId: Math.max(1, nextRowId - 1) });
      } else {
        deltas.push({ op: 'state.updated', patch: { trip: { days: [`day-${i}`] } } });
      }
    }
    return deltas;
  }

  it('不同随机序列下终态（含 seq）逐字节一致', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const list = sequence(seed, 40);
      const framesList = frames(list);
      const direct = applyFrames(base(), framesList);
      const merged = applyFrames(base(), coalesceFrames(framesList));
      assert.deepEqual(merged, direct, `seed=${seed}`);
    }
  });
});
describe('客户端归约（三铁律）与直播 Trip 组装', () => {
  it('快照整体替换；衔接帧应用；断档要求重订阅；重复帧丢弃', () => {
    const snapshot = applyFrames(emptySnapshot<Row, State>({ trip: { days: [] }, cursor: 0, phase: 'idle' }), frames([
      { op: 'state.updated', patch: { phase: 'plan' } },
    ]));
    const replaced = reduceProjectionMessage(null, { kind: 'snapshot', snapshot });
    assert.equal(replaced.kind, 'applied');

    const applied = reduceProjectionMessage(snapshot, {
      kind: 'delta',
      frame: { fromSeq: snapshot.seq, toSeq: snapshot.seq + 1, delta: { op: 'row.appended', row: { rowId: 1, label: 'd1' } } },
    });
    assert.equal(applied.kind, 'applied');
    assert.equal(applied.snapshot?.rows.window.length, 1);

    const gap = reduceProjectionMessage(snapshot, {
      kind: 'delta',
      frame: { fromSeq: snapshot.seq + 5, toSeq: snapshot.seq + 6, delta: { op: 'state.updated', patch: { phase: 'x' } } },
    });
    assert.equal(gap.kind, 'resync');

    const duplicate = reduceProjectionMessage(snapshot, {
      kind: 'delta',
      frame: { fromSeq: 0, toSeq: 1, delta: { op: 'state.updated', patch: { phase: 'x' } } },
    });
    assert.equal(duplicate.kind, 'ignored');
  });

  it('tripFromProjection 用头 + 行组装直播行程', () => {
    const snapshot: TripProjectionSnapshot = {
      seq: 2,
      rows: { window: [{ rowId: 1, kind: 'day', dayIndex: 1, title: '市区', activities: [], legs: [] }], totalCount: 1, firstRowId: 1 },
      state: {
        trip: { id: 'job-1', title: '成都 · 生成中', destination: '成都', startDate: '2026-11-10', updatedAt: 0 },
        control: { phase: 'plan', status: 'running' },
        taskGraph: [], usage: null, pendingInteractions: [], availability: { canSend: true },
      },
    };
    const trip = tripFromProjection(snapshot)!;
    assert.equal(trip.id, 'job-1');
    assert.equal(trip.destination, '成都');
    assert.deepEqual(trip.days.map((day) => day.dayIndex), [1]);
    assert.equal(tripFromProjection({ ...snapshot, state: { ...snapshot.state, trip: null } }), null);
  });
});
