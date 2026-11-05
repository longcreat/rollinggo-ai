import { Value } from '@sinclair/typebox/value';
import { ChatFollowUpSchema, type ChatFollowUp } from './detailChat';
import type { Trip } from './types';

/** 校验与去重同时用于服务端落库和最新回答的前端兼容展示。 */
export function readFollowUpSuggestions(value: unknown, question: string): ChatFollowUp[] {
  if (!Array.isArray(value)) return [];
  const labels = new Set<string>();
  const texts = new Set([question.trim()]);
  const suggestions: ChatFollowUp[] = [];
  for (const item of value) {
    if (!Value.Check(ChatFollowUpSchema, item)) continue;
    const label = item.label.trim();
    const text = item.text.trim();
    if (labels.has(label) || texts.has(text)) continue;
    labels.add(label); texts.add(text);
    suggestions.push({ label, text, kind: item.kind });
    if (suggestions.length === 3) break;
  }
  return suggestions;
}

/** 从本轮回答提取引用片段补足追问，不回退到与回答无关的固定菜单。 */
export function completeFollowUpSuggestions(value: unknown, input: { question: string; answer: string; trip: Trip; dayId?: string }): ChatFollowUp[] {
  const existing = readFollowUpSuggestions(value, input.question);
  if (existing.length >= 2) return existing;
  const prose = input.answer.replace(/https?:\/\/\S+/g, '').replace(/[*#`\[\]「」]/g, '').trim();
  const theme = [
    { label: '轮渡出行', pattern: /轮渡|渡轮|码头/ },
    { label: '开放与预约', pattern: /预约|门票|营业|闭馆|开放/ },
    { label: '沿途用餐', pattern: /餐厅|餐馆|美食|午餐|晚餐|用餐/ },
    { label: '行程节奏', pattern: /步行|节奏|休息/ },
  ].find((item) => item.pattern.test(prose));
  const sentences = prose.split(/[。！？\n]/).map((part) => part.trim()).filter((part) => part.length >= 4);
  const excerpt = (sentences.find((part) => theme?.pattern.test(part)) || sentences.find((part) => part.length >= 8) || sentences[0] || input.question.trim()).slice(0, 36);
  const day = input.trip.days.find((item) => item.id === input.dayId);
  const scope = `${input.trip.destination}${day ? `第 ${day.dayIndex} 天` : '这趟行程'}`;
  const topic = theme?.label ?? '刚才的建议';
  const related = [
    { label: `展开了解${topic}`, text: `关于刚才回答中的「${excerpt}」，能结合${scope}进一步说明具体做法吗？` },
    { label: `${topic}有哪些注意事项`, text: `结合${scope}，刚才提到的「${excerpt}」还有哪些限制或需要提前核实的信息？` },
    { label: '看看其他可选方案', text: `针对刚才提到的「${excerpt}」，${scope}还有哪些可选方案？请先给建议。` },
  ].map((item) => ({ ...item, kind: 'follow_up' as const }));
  return readFollowUpSuggestions([...existing, ...related], input.question).slice(0, 2);
}

