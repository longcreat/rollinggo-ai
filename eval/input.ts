import type { GenerateForm } from '@tripweaver/shared';

/** 预算仅是旧 JSON 的兼容字段；不同历史值不能影响当前评估输入口径。 */
export function evaluationInput(form: GenerateForm) {
  const { budgetLevel: _level, totalBudget: _total, ...current } = form;
  return { ...current, pace: form.pace ?? 'moderate', transportMode: form.transportMode ?? 'transit' };
}
