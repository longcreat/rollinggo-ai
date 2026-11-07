// 回答里声称「已改动」但本轮没有任何写操作时，追加纠正。
// 模型偶尔只调用只读工具却用完成时汇报改动；这属于对用户状态的误导，必须由服务端兜底。
const CLAIM = /(?:已|已经)(?:改动|改好|修好|调整|换成|挪到|更新|重排|修正)/;

export function claimsUnappliedEdit(answer: string, applied: boolean): boolean {
  return !applied && CLAIM.test(answer);
}

export function withEditCorrection(answer: string): string {
  return `${answer}\n\n（说明：本轮没有实际修改行程，以上是建议；要我直接改可以继续告诉我。）`.slice(0, 4000);
}
