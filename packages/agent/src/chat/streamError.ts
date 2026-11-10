// 详情对话流式端点的错误文案与事件码。
//
// 单独成模块是为了可测：路由里的 catch 分支一旦写错，用户看到的是「回答中断」而不是真正原因，
// 而这条路径依赖 SSE、鉴权和数据库，很难在集成测试里覆盖。
export type StreamErrorCode = 'timeout' | 'stopped' | 'busy' | 'chat_failed';

export interface StreamErrorState {
  timedOut: boolean;
  stopped: boolean;
}

/** 4xx 是已知业务错（额度、并发、版本过期），可以把真实文案交给用户；5xx 一律收敛成可重试提示。 */
export function streamErrorPayload(error: unknown, state: StreamErrorState): { code: StreamErrorCode; error: string } {
  const status = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
    ? error.statusCode
    : undefined;
  const expected = status !== undefined && status < 500;
  const busy = error instanceof Error && (error as { code?: unknown }).code === 'AGENT_BUSY';
  const message = error instanceof Error ? error.message : '';
  return {
    code: state.timedOut ? 'timeout' : state.stopped ? 'stopped' : busy ? 'busy' : 'chat_failed',
    error: state.timedOut
      ? '处理超时，原行程未改动，请重试或缩小范围'
      : state.stopped
        ? '已停止'
        : expected
          ? message
          : '回答中断，请重试',
  };
}
