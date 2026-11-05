// 选点权重（09-22）：社区推荐分（质量）0.6 + 提及次数（热度）0.4，金集来源额外加分。
//
// 两条不能违反的规则：
// 1. **分数缺失不能当 0**。金集回填的行原本没有 recommendScore（payload 只有 caseId+activity），
//    当 0 会让故宫/天坛/北海这些地标排在链尾、段落最后，并在容量紧张时被优先丢弃 ——
//    排序被彻底反转（实测：故宫落到 Day3）。缺失一律按池内中位（0.5）处理，不惩罚。
// 2. **金集自带加分**。金集是从人工评估过的行程快照回填的，本身就是「已知靠谱」的强信号，
//    比拿中位数糊过去语义更正确；等上游把分数导出到金集行之后这个加分只是兜底。
// 纯函数、零 IO。
export const GOLDSET_SCORE_BONUS = 15;

/** 缺值时的中性比例（≈池内中位），避免「没数据 = 最差」 */
export const NEUTRAL_RATIO = 0.5;

export interface PoiScoreFacts {
  /** payload.recommendScore：社区推荐分 */
  recommendScore?: number;
  /** payload.mentionCount：被提及次数 */
  mentionCount?: number;
  /** canonical_places.source：goldset | xhs | amap | manual … */
  source?: string;
}

export interface ScoreMaxima {
  score: number;
  mention: number;
}

function ratio(value: number | undefined, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NEUTRAL_RATIO;
  if (max <= 0) return NEUTRAL_RATIO;
  return Math.max(0, Math.min(1, value / max));
}

/** 选点与分天权重：0~100 的归一化合成分 + 金集加分 */
export function poiScore(facts: PoiScoreFacts | undefined, maxima: ScoreMaxima): number {
  const quality = ratio(facts?.recommendScore, maxima.score) * 60;
  const heat = ratio(facts?.mentionCount, maxima.mention) * 40;
  const bonus = facts?.source === 'goldset' ? GOLDSET_SCORE_BONUS : 0;
  return quality + heat + bonus;
}

/** 归一化基准：只统计**有值**的样本，否则缺失值会把整体压小、放大相对差异 */
export function scoreMaxima(factsList: readonly (PoiScoreFacts | undefined)[]): ScoreMaxima {
  const scores = factsList.map((f) => f?.recommendScore).filter((v): v is number => typeof v === 'number');
  const mentions = factsList.map((f) => f?.mentionCount).filter((v): v is number => typeof v === 'number');
  return {
    score: scores.length ? Math.max(...scores) : 0,
    mention: mentions.length ? Math.max(...mentions) : 0,
  };
}
