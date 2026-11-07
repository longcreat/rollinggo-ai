// 回答里声称「已改动/已生成」但本轮没有任何写操作时，追加纠正。
// 模型偶尔只调用只读工具（或刚委派后台任务）却用完成时汇报结果；这属于对用户状态的误导，必须由服务端兜底。
// 只匹配「完成」语义：已为你生成新的… / 已生成好 / 已重新生成了；不匹配「已开始生成」。
const EDIT_CLAIM = /(?:已|已经)(?:改动|改好|修好|调整|换成|挪到|更新|重排|修正)/;
const GENERATE_CLAIM = /(?:已|已经)[^。！？\n]{0,6}?生成(?:好|完成|新的|了|出)/;
const CLAIM = new RegExp(`${EDIT_CLAIM.source}|${GENERATE_CLAIM.source}`);

export function claimsUnappliedEdit(answer: string, applied: boolean): boolean {
  return !applied && CLAIM.test(answer);
}

export function withEditCorrection(answer: string): string {
  return `${answer}\n\n（说明：本轮没有实际修改或生成行程；以上是说明或建议，结果以行程版本与任务状态为准。）`.slice(0, 4000);
}
