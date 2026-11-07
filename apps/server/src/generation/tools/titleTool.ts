// 文案阶段唯一的写入口（自 draftTools.ts 拆出）：结构由确定性排程决定，文案阶段只负责行程标题与每天标题。
// 活动说明不再由模型编写——research 阶段的候选 intro 已按同一标准写成（≤60 字），
// 排程直接把它用作活动 description，不需要第二次编写。
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { defineTool } from './defineTool';
import type { DraftTrip } from '../draft';
import { missingTitleCharacters } from '../titleFont';

function text(t: string) {
  return [{ type: 'text' as const, text: t }];
}

/** 标题写入口（09-25）。用独立工具而不是复用 set_trip_skeleton：后者会重建 days 并清空已排好的活动。 */
export function buildTitleTool(draft: DraftTrip, onTitlesSubmitted?: (notes: string[]) => void): AgentTool {
  return defineTool({
    name: 'update_titles',
    label: '撰写行程标题',
    description: '改写行程标题与每天标题。写入前按实际手写字体 cmap 校验全部字符；缺字时返回缺失字符且不写入，请改用已收录字重新拟题。只能改文字，不能改天数、活动、顺序或说明。',
    parameters: Type.Object({
      title: Type.String({ description: '行程标题，≤20 字，点出这趟行程的特色' }),
      dayTitles: Type.Array(Type.String(), {
        description: '每天的主题标题（≤12 字，概括那天的内容与气质，不要罗列活动名），数组长度必须等于天数，按天序给出',
      }),
      notes: Type.Optional(Type.Array(Type.String(), { maxItems: 3, description: '可选实用建议，最多3条，无需另外提交' })),
    }),
    execute: async (_id, params) => {
      if (!params.title.trim() || Array.from(params.title.trim()).length > 20
        || params.dayTitles.length !== draft.mutableDays().length
        || params.dayTitles.some((title) => !title.trim() || Array.from(title.trim()).length > 12)) {
        return { content: text('错误：行程标题须为1–20字，每天标题须为1–12字，且每天标题数量必须等于行程天数。所有标题均未写入。'), details: { isError: true } };
      }
      const missingCharacters = missingTitleCharacters([params.title, ...params.dayTitles]);
      if (missingCharacters.length) {
        return {
          content: text(`错误：手写字体 cmap 未收录这些字符：${missingCharacters.join('、')}。所有标题均未写入。请换用已收录的字重新拟题；可概括行程内容，但不得篡改真实地名或活动信息。`),
          details: { isError: true, missingCharacters },
        };
      }
      const message = draft.updateTitles(params.title, params.dayTitles);
      const isError = message.startsWith('错误');
      if (!isError) onTitlesSubmitted?.((params.notes ?? []).slice(0, 3).map((note) => note.slice(0, 200)));
      return {
        content: text(message), details: { title: params.title, days: params.dayTitles.length, isError },
        ...(!isError && onTitlesSubmitted ? { terminate: true } : {}),
      };
    },
  });
}
