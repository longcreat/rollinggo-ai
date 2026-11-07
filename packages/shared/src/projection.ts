// 统一投影协议（照抄 zcode `zcode-protocol-v4` 的 apply/coalesce 语义，2026-11-07）。
//
// 设计约束（与上游一致，刻意不发明）：
//   - op 集合封闭：row.appended / row.upserted / row.removed / row.delta / state.updated。
//     没有中间插入、没有移动、没有字段级 JSON patch —— 表达不了的结构变化一律发 snapshot resync，
//     用带宽换客户端的正确性。
//   - state.updated 是**键级整体替换**（浅合并），键内绝不深合并。
//   - applyAll(s, coalesce(ds)) 必须与 applyAll(s, ds) 逐字节一致（黄金不变量，由单测把守）。
//   - 客户端三条铁律（宿主化改写不得引入额外分支）：
//       1. snapshot 整体替换，绝不 merge；
//       2. delta 仅在区间衔接（frame.fromSeq === snapshot.seq）时 apply，断档不猜、不缓存补偿；
//       3. 断档时携当前水位重订阅，由服务端裁决 resume / snapshot。

export interface ProjectionRowBase {
  readonly rowId: number;
  /** 流式正文（`row.delta` 的追加目标）。结构化行可以为空。 */
  text?: string;
}

export interface ProjectionRows<Row extends ProjectionRowBase> {
  /** 已加载的行窗口，按 rowId 升序。 */
  window: Row[];
  /** 当前分支累计行数（含已被窗口裁掉的历史）。 */
  totalCount: number;
  /** 窗口首行的 rowId；窗口为空时为 null。 */
  firstRowId: number | null;
}

export interface ProjectionSnapshot<Row extends ProjectionRowBase, State> {
  /** 已应用到的最后一个序号。 */
  seq: number;
  rows: ProjectionRows<Row>;
  state: State;
}

export type ProjectionPath = 'text';

export type ProjectionDelta<Row extends ProjectionRowBase, State> =
  | { op: 'row.appended'; row: Row }
  | { op: 'row.upserted'; row: Row }
  /** 删除该行及之后的所有行（撤销 / 重试回退）。 */
  | { op: 'row.removed'; fromRowId: number }
  /** 仅作用于流式行；行不存在 / 不是文本行时 no-op。 */
  | { op: 'row.delta'; rowId: number; path: ProjectionPath; append: string }
  | { op: 'state.updated'; patch: Partial<State> };

/** 线上信封：`fromSeq` 是这条 delta 应当作用在的快照水位，`toSeq` 是应用后的水位。 */
export interface ProjectionFrame<Row extends ProjectionRowBase, State> {
  fromSeq: number;
  toSeq: number;
  delta: ProjectionDelta<Row, State>;
}

export function emptySnapshot<Row extends ProjectionRowBase, State>(state: State): ProjectionSnapshot<Row, State> {
  return { seq: 0, rows: { window: [], totalCount: 0, firstRowId: null }, state };
}

function appendText<Row extends ProjectionRowBase>(row: Row, append: string): Row {
  return { ...row, text: `${row.text ?? ''}${append}` };
}

/** 从尾部查找（项目 target 为 ES2022，不用 findLastIndex）；upsert/delta 的目标通常在尾部。 */
function lastIndexOfRow<Row extends ProjectionRowBase>(rows: readonly Row[], rowId: number): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]!.rowId === rowId) return index;
  }
  return -1;
}

/** 区间是否衔接：客户端只能在这个条件下应用 delta，否则必须重订阅。 */
export function isContiguous<Row extends ProjectionRowBase, State>(
  snapshot: ProjectionSnapshot<Row, State>,
  frame: { fromSeq: number },
): boolean {
  return frame.fromSeq === snapshot.seq;
}

/** 应用单条 delta，返回新快照（入参不被修改）。 */
export function applyDelta<Row extends ProjectionRowBase, State>(
  snapshot: ProjectionSnapshot<Row, State>,
  delta: ProjectionDelta<Row, State>,
  toSeq: number = snapshot.seq + 1,
): ProjectionSnapshot<Row, State> {
  switch (delta.op) {
    case 'row.appended':
      return {
        ...snapshot,
        seq: toSeq,
        rows: {
          ...snapshot.rows,
          window: [...snapshot.rows.window, delta.row],
          totalCount: snapshot.rows.totalCount + 1,
          firstRowId: snapshot.rows.firstRowId ?? delta.row.rowId,
        },
      };
    case 'row.upserted': {
      // 窗口内 rowId 唯一且单调；upsert 的目标通常是尾部流式行，从尾部查找。
      const index = lastIndexOfRow(snapshot.rows.window, delta.row.rowId);
      if (index === -1) return { ...snapshot, seq: toSeq }; // 未加载行 = no-op
      const window = [...snapshot.rows.window];
      window[index] = delta.row;
      return { ...snapshot, seq: toSeq, rows: { ...snapshot.rows, window } };
    }
    case 'row.removed': {
      const window = snapshot.rows.window.filter((row) => row.rowId < delta.fromRowId);
      const removed = snapshot.rows.window.length - window.length;
      // 从首行开始裁剪 = 整条活动分支被撤销：分页锚点与计数必须清零，下一次 append 重建。
      const removesEntireBranch = snapshot.rows.firstRowId !== null && delta.fromRowId <= snapshot.rows.firstRowId;
      return {
        ...snapshot,
        seq: toSeq,
        rows: {
          ...snapshot.rows,
          window,
          totalCount: removesEntireBranch ? 0 : Math.max(0, snapshot.rows.totalCount - removed),
          firstRowId: removesEntireBranch ? null : snapshot.rows.firstRowId,
        },
      };
    }
    case 'row.delta': {
      const index = lastIndexOfRow(snapshot.rows.window, delta.rowId);
      const target = snapshot.rows.window[index];
      if (index === -1 || target === undefined) return { ...snapshot, seq: toSeq };
      const window = [...snapshot.rows.window];
      window[index] = appendText(target, delta.append);
      return { ...snapshot, seq: toSeq, rows: { ...snapshot.rows, window } };
    }
    case 'state.updated':
      // 键级整体替换：patch 中在场的键覆盖，绝不深合并。
      return { ...snapshot, seq: toSeq, state: { ...snapshot.state, ...delta.patch } };
  }
}

/** 按序应用一串 frame（水位来自 frame.toSeq，不按 delta 条数推导）。 */
export function applyFrames<Row extends ProjectionRowBase, State>(
  snapshot: ProjectionSnapshot<Row, State>,
  frames: readonly ProjectionFrame<Row, State>[],
): ProjectionSnapshot<Row, State> {
  let current = snapshot;
  for (const frame of frames) current = applyDelta(current, frame.delta, frame.toSeq);
  return current;
}

function isBarrier<Row extends ProjectionRowBase, State>(delta: ProjectionDelta<Row, State>): boolean {
  return delta.op === 'row.removed';
}

/**
 * 对一个 flush 窗口内的 delta 序列做语义保持合并（规则集合封闭）：
 *   1. 相邻同 (rowId, path) 的 row.delta → append 拼接；
 *   2. 相邻 state.updated → patch 键浅合并；
 *   3. row.upserted 吞掉同 rowId 更早的 row.delta（整行替换蕴含所有追加）；
 *   4. row.removed 是屏障，任何规则不得跨越；
 *   5. 相邻同 rowId 的 row.upserted → 留最后一条。
 * 不修改入参，输出保持权威日志序。
 */
export function coalesceDeltas<Row extends ProjectionRowBase, State>(
  deltas: readonly ProjectionDelta<Row, State>[],
): ProjectionDelta<Row, State>[] {
  const result: ProjectionDelta<Row, State>[] = [];

  for (const delta of deltas) {
    // 规则 3：只回溯到最近的屏障，且不越过同 rowId 的前一次 upserted/appended（否则会吞掉上一代行的追加）。
    if (delta.op === 'row.upserted') {
      for (let i = result.length - 1; i >= 0; i -= 1) {
        const prev = result[i];
        if (prev === undefined || isBarrier(prev)) break;
        if (prev.op === 'row.delta' && prev.rowId === delta.row.rowId) {
          result.splice(i, 1);
          continue;
        }
        if ((prev.op === 'row.upserted' || prev.op === 'row.appended') && prev.row.rowId === delta.row.rowId) break;
      }
    }

    const last = result[result.length - 1];

    // 规则 1：相邻同 (rowId, path) 的 row.delta 拼接。
    if (delta.op === 'row.delta' && last?.op === 'row.delta' && last.rowId === delta.rowId && last.path === delta.path) {
      result[result.length - 1] = { op: 'row.delta', rowId: delta.rowId, path: delta.path, append: last.append + delta.append };
      continue;
    }

    // 规则 2：相邻 state.updated 浅合并（后者的键覆盖前者；键内整体替换所以安全）。
    if (delta.op === 'state.updated' && last?.op === 'state.updated') {
      result[result.length - 1] = { op: 'state.updated', patch: { ...last.patch, ...delta.patch } };
      continue;
    }

    // 规则 5：相邻同 rowId 的 row.upserted 留最后一条。
    if (delta.op === 'row.upserted' && last?.op === 'row.upserted' && last.row.rowId === delta.row.rowId) {
      result[result.length - 1] = delta;
      continue;
    }

    result.push(delta);
  }

  return result;
}

/**
 * 合并 frame 批：贪心地把相邻且内容可合并的帧并成一条（水位取更晚的 toSeq）。
 * 不可合并（含 row.removed 屏障）或区间不连续时原样保留，因此
 * `applyFrames(s, coalesceFrames(fs))` 与 `applyFrames(s, fs)` 终态完全一致，包括 seq。
 */
export function coalesceFrames<Row extends ProjectionRowBase, State>(
  frames: readonly ProjectionFrame<Row, State>[],
): ProjectionFrame<Row, State>[] {
  const result: ProjectionFrame<Row, State>[] = [];
  let index = 0;
  while (index < frames.length) {
    let current = frames[index]!;
    let next = index + 1;
    while (next < frames.length && frames[next]!.fromSeq === current.toSeq) {
      const merged = coalesceDeltas([current.delta, frames[next]!.delta]);
      if (merged.length !== 1) break;
      current = { fromSeq: current.fromSeq, toSeq: frames[next]!.toSeq, delta: merged[0]! };
      next += 1;
    }
    result.push(current);
    index = next;
  }
  return result;
}