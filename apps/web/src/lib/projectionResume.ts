// REST 重订阅的归约：服务端要么给整份快照，要么给按水位补齐的帧序列（可能为空）。
// SSE 每帧单独到达，走 reduceProjectionMessage；这里只额外处理「帧数组」这一层，
// 不改变三铁律：断档返回 resync，由宿主携当前水位重订阅。
import {
  reduceProjectionMessage,
  type ProjectionFrame,
  type ProjectionRowBase,
  type ProjectionSnapshot,
} from '@rollinggo-trip/shared';

export type ProjectionResumeMessage<Row extends ProjectionRowBase, State> =
  | { kind: 'snapshot'; snapshot: ProjectionSnapshot<Row, State> }
  | { kind: 'delta'; frames: ProjectionFrame<Row, State>[] };

export type ProjectionResumeResult<Row extends ProjectionRowBase, State> =
  | { kind: 'applied'; snapshot: ProjectionSnapshot<Row, State> | null }
  | { kind: 'resync'; snapshot: ProjectionSnapshot<Row, State> | null };

export function applyProjectionResume<Row extends ProjectionRowBase, State>(
  current: ProjectionSnapshot<Row, State> | null,
  message: ProjectionResumeMessage<Row, State>,
): ProjectionResumeResult<Row, State> {
  if (message.kind === 'snapshot') return { kind: 'applied', snapshot: message.snapshot };
  let snapshot = current;
  for (const frame of message.frames) {
    const result = reduceProjectionMessage(snapshot, { kind: 'delta', frame });
    if (result.kind === 'resync') return { kind: 'resync', snapshot };
    if (result.kind === 'applied') snapshot = result.snapshot;
  }
  return { kind: 'applied', snapshot };
}
