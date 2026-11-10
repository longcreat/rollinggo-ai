// REST 重订阅的帧序列归约：空帧、多帧连续、断档重订阅、整份快照。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  emptySnapshot,
  emptyTripProjectionState,
  type TripProjectionFrame,
  type TripProjectionSnapshot,
} from '@rollinggo-trip/shared';
import { applyProjectionResume } from '../src/lib/projectionResume';

const empty = (): TripProjectionSnapshot => emptySnapshot(emptyTripProjectionState());

const headerFrame: TripProjectionFrame = {
  fromSeq: 0,
  toSeq: 1,
  delta: {
    op: 'state.updated',
    patch: { trip: { id: 'job-1', title: '上海 · 生成中', destination: '上海', startDate: '', updatedAt: 0 } },
  },
};
const rowFrame: TripProjectionFrame = {
  fromSeq: 1,
  toSeq: 2,
  delta: { op: 'row.appended', row: { rowId: 1, kind: 'day', dayIndex: 1, title: 'D1', activities: [], legs: [] } },
};

test('空帧序列：不改变快照，也不判为断档', () => {
  const result = applyProjectionResume(null, { kind: 'delta', frames: [] });
  assert.equal(result.kind, 'applied');
  assert.equal(result.snapshot, null);

  const current = empty();
  const applied = applyProjectionResume(current, { kind: 'delta', frames: [] });
  assert.equal(applied.kind, 'applied');
  assert.equal(applied.snapshot, current);
});

test('多帧按顺序应用', () => {
  const result = applyProjectionResume(empty(), { kind: 'delta', frames: [headerFrame, rowFrame] });
  assert.equal(result.kind, 'applied');
  assert.equal(result.snapshot?.seq, 2);
  assert.equal(result.snapshot?.state.trip?.destination, '上海');
  assert.equal(result.snapshot?.rows.window.length, 1);
});

test('区间不连续返回 resync，不猜测补偿', () => {
  const gap: TripProjectionFrame = { ...rowFrame, fromSeq: 9, toSeq: 10 };
  const result = applyProjectionResume(empty(), { kind: 'delta', frames: [gap] });
  assert.equal(result.kind, 'resync');
});

test('快照消息整体替换', () => {
  const snapshot = empty();
  const result = applyProjectionResume(null, { kind: 'snapshot', snapshot });
  assert.equal(result.kind, 'applied');
  assert.equal(result.snapshot, snapshot);
});
