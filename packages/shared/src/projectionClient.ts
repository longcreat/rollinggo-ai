// 客户端投影归约（zcode 三条铁律的宿主化改写，不得引入额外分支）：
//   1. snapshot 整体替换，绝不 merge；
//   2. delta 仅在区间衔接（frame.fromSeq === 当前 seq）时应用；
//   3. 断档不猜、不缓存补偿 —— 返回 resync，由宿主携当前水位重订阅，服务端裁决补帧或重发快照。
import { applyDelta, type ProjectionFrame, type ProjectionRowBase, type ProjectionSnapshot } from './projection';

export type ProjectionMessage<Row extends ProjectionRowBase, State> =
  | { kind: 'snapshot'; snapshot: ProjectionSnapshot<Row, State> }
  | { kind: 'delta'; frame: ProjectionFrame<Row, State> };

export type ProjectionReduceResult<Row extends ProjectionRowBase, State> =
  | { kind: 'applied'; snapshot: ProjectionSnapshot<Row, State> }
  /** 重连后重复下发的旧帧（toSeq 已应用过）：直接丢弃。 */
  | { kind: 'ignored'; snapshot: ProjectionSnapshot<Row, State> }
  /** 区间不连续：宿主必须重订阅。 */
  | { kind: 'resync'; snapshot: ProjectionSnapshot<Row, State> | null };

export function reduceProjectionMessage<Row extends ProjectionRowBase, State>(
  current: ProjectionSnapshot<Row, State> | null,
  message: ProjectionMessage<Row, State>,
): ProjectionReduceResult<Row, State> {
  if (message.kind === 'snapshot') return { kind: 'applied', snapshot: message.snapshot };
  if (!current) return { kind: 'resync', snapshot: null };
  if (message.frame.toSeq <= current.seq) return { kind: 'ignored', snapshot: current };
  if (message.frame.fromSeq !== current.seq) return { kind: 'resync', snapshot: current };
  return {
    kind: 'applied',
    snapshot: applyDelta(current, message.frame.delta, message.frame.toSeq),
  };
}