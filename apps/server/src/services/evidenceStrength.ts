// 社区语料（research_evidence）的强度决策：导入时唯一入口，避免靠迁移按 kind 批量回填。
//
// 语义：direct = 有多条可核查来源；weak = 单条或无法追溯；risk_only = 只作风险提示。
// 预约与价格两类语料常来自预约平台截图/列表文字，source_url 为空 —— 它们不足以单独支撑「需预约」结论，
// 一律降为 weak（2026-10-06：天坛公园「提前7天；提前1天00:00预约」就是这么进的库）。
const KIND_DEFAULT: Record<string, string> = { xhs_reason: 'weak', xhs_warning: 'risk_only' };
const SOURCELESS_DOWNGRADE = new Set(['xhs_reservation', 'xhs_price']);

export function evidenceStrength(item: { kind: string; sourceUrl?: string; strength?: string }): string {
  if (item.strength) return item.strength;
  if (!item.sourceUrl && SOURCELESS_DOWNGRADE.has(item.kind)) return 'weak';
  return KIND_DEFAULT[item.kind] ?? 'direct';
}
