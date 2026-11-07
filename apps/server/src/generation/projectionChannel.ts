// 投影信道：服务端唯一的水位分配者与断档裁决者。
//
// 真相在持久化状态（或内存快照），SSE 只是易失通知：
//   - publish() 给每条 delta 分配连续水位，并返回可下发的 frame；
//   - resume(fromSeq) 决定「补发增量」还是「整体重发 snapshot」——客户端断档时不猜不补偿。
// 缓冲有界：落后超过缓冲窗口的客户端直接拿到 snapshot（带宽换正确性）。
import {
  applyDelta,
  type ProjectionDelta,
  type ProjectionFrame,
  type ProjectionRowBase,
  type ProjectionSnapshot,
} from '@tripweaver/shared';

export type ProjectionResume<Row extends ProjectionRowBase, State> =
  | { kind: 'delta'; frames: ProjectionFrame<Row, State>[] }
  | { kind: 'snapshot'; snapshot: ProjectionSnapshot<Row, State> };

export class ProjectionChannel<Row extends ProjectionRowBase, State> {
  #snapshot: ProjectionSnapshot<Row, State>;
  #frames: ProjectionFrame<Row, State>[] = [];
  readonly #limit: number;

  constructor(initial: ProjectionSnapshot<Row, State>, limit = 256) {
    this.#snapshot = initial;
    this.#limit = Math.max(1, limit);
  }

  get snapshot(): ProjectionSnapshot<Row, State> {
    return this.#snapshot;
  }

  /** 分配下一水位、应用到快照、缓冲 frame；返回可下发给订阅者的 frame。 */
  publish(delta: ProjectionDelta<Row, State>): ProjectionFrame<Row, State> {
    const frame: ProjectionFrame<Row, State> = {
      fromSeq: this.#snapshot.seq,
      toSeq: this.#snapshot.seq + 1,
      delta,
    };
    this.#snapshot = applyDelta(this.#snapshot, delta, frame.toSeq);
    this.#frames.push(frame);
    if (this.#frames.length > this.#limit) this.#frames.shift();
    return frame;
  }

  /**
   * 客户端携水位重订阅：能补齐就补增量，补不了就整体重发快照。
   * `fromSeq` 超前（客户端比服务端新）同样按快照处理，不做任何猜测。
   */
  resume(fromSeq: number): ProjectionResume<Row, State> {
    if (fromSeq === this.#snapshot.seq) return { kind: 'delta', frames: [] };
    const oldest = this.#frames[0]?.fromSeq;
    if (fromSeq > this.#snapshot.seq || oldest === undefined || fromSeq < oldest) {
      return { kind: 'snapshot', snapshot: this.#snapshot };
    }
    return { kind: 'delta', frames: this.#frames.filter((frame) => frame.fromSeq >= fromSeq) };
  }
}