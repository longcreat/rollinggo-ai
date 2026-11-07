import { placeNameKey } from './placeIdentity';

/**
 * 展示层名称关联（**不是**实体身份判定）：把活动名与候选/缓存点位按名称对上，
 * 用于「给已有活动配图、复用已核验坐标」这类可容忍漏配的场景。
 *
 * 实体是否相同请走 `samePlaceReference` / canonicalPlaceId；文本相似永远不能当实体相等。
 *
 * 护栏：短名极易误命中（「西湖」⊂「西湖醋鱼」）。精确相等由调用方先判；这里只在
 * 短侧 ≥3 字且长度不低于长侧一半时接受包含 —— 2 字名（西湖/故宫/外滩）歧义太大，只认精确匹配。
 * 宁可落「位置待核实」，也不把餐厅坐标安到景点头上。
 */
export function placeNameContains(a: string, b: string): boolean {
  return placeNameContainsKey(placeNameKey(a), placeNameKey(b));
}

/**
 * 调用方已自行归一化时使用（例如 web 的 normalizeName 还会去标点，比 placeNameKey 更激进）。
 * 传入的两个 key 必须非空；这里只做长度与包含判定，不再归一化。
 */
export function placeNameContainsKey(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  if (short.length < 3) return false;
  return short.length * 2 >= long.length && long.includes(short);
}