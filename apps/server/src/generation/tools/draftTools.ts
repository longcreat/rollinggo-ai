// 编排 Agent 的草稿读写工具组：DraftTrip 是唯一可变状态，工具返回文本供模型自愈（R2）
import { Type } from 'typebox';
import { describeFeasibility } from '@tripweaver/shared';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { defineTool } from './defineTool';
import type { DraftTrip, DraftActivityInput } from '../draft';
import { missingTitleCharacters } from '../titleFont';

function text(t: string) {
  return [{ type: 'text' as const, text: t }];
}

const OptionalActivityFields = {
  placeName: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: '实际定位地名。餐次只填片区/街道，如「春熙路」，不含午餐/晚餐标签或菜系。' })),
  poiId: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: '候选池地点 id；引用已有候选时填写，系统复用其真实坐标。' })),
  startTime: Type.Optional(Type.String({ description: '开始时间 HH:mm，如 09:00' })),
  endTime: Type.Optional(Type.String({ description: '结束时间 HH:mm' })),
  description: Type.Optional(Type.String({ description: '亮点与实用提示，≤60 字' })),
  category: Type.Optional(Type.String({ description: '美食/文化/自然/购物/住宿/交通/娱乐/其他' })),
  lat: Type.Optional(Type.Number({ description: '纬度（geocode_place 的返回）' })),
  lng: Type.Optional(Type.Number({ description: '经度' })),
  sourceNotes: Type.Optional(
    Type.Array(Type.Object({ title: Type.String(), url: Type.String() }), {
      description: '来源笔记（仅可用调研摘要中出现过的链接）',
    }),
  ),
};

export function buildDraftTools(draft: DraftTrip, mode: 'plan' | 'revision' = 'plan', onTitlesSubmitted?: (notes: string[]) => void): AgentTool[] {
  const skeletonTool = defineTool({
    name: 'set_trip_skeleton',
    label: '建立行程骨架',
    description: '设定行程标题与每天的主题（调用一次即可，重复调用会清空已填活动）。',
    parameters: Type.Object({
      title: Type.String({ description: '行程标题，如「东京五日美食漫步」' }),
      dayTitles: Type.Array(Type.String(), { description: '每天的主题短语，数组长度 = 天数' }),
    }),
    execute: async (_id, params) => ({
      content: text(draft.setSkeleton(params.title, params.dayTitles)),
      details: { days: params.dayTitles.length },
    }),
  });

  const addTool = defineTool({
    name: 'add_activity',
    label: '添加活动',
    description: '向某一天添加一个活动。可在同一条消息里并行发多个 add_activity。',
    parameters: Type.Object({
      dayIndex: Type.Integer({ description: '第几天（从 1 开始）' }),
      name: Type.String({ description: '活动名称' }),
      ...OptionalActivityFields,
    }),
    execute: async (_id, params) => {
      const { dayIndex, ...input } = params;
      const msg = draft.addActivity(dayIndex, input as DraftActivityInput);
      return { content: text(msg), details: { dayIndex, name: params.name, isError: msg.startsWith('错误') } };
    },
  });

  const updateTool = defineTool({
    name: 'update_activity',
    label: '修改活动',
    description: '修改某天第 N 个活动的字段（只传需要修改的字段）。位置编号见 get_draft 输出。',
    parameters: Type.Object({
      dayIndex: Type.Integer({ description: '第几天（从 1 开始）' }),
      position: Type.Integer({ description: '该天第几个活动（从 1 开始）' }),
      name: Type.Optional(Type.String({ description: '活动名称' })),
      ...OptionalActivityFields,
    }),
    execute: async (_id, params) => {
      const { dayIndex, position, ...patch } = params;
      return { content: text(draft.updateActivity(dayIndex, position, patch as DraftActivityInput)), details: { dayIndex, position } };
    },
  });

  const removeTool = defineTool({
    name: 'remove_activity',
    label: '删除活动',
    description: '删除某天第 N 个活动。',
    parameters: Type.Object({
      dayIndex: Type.Integer({ description: '第几天（从 1 开始）' }),
      position: Type.Integer({ description: '该天第几个活动（从 1 开始）' }),
    }),
    execute: async (_id, params) => ({
      content: text(draft.removeActivity(params.dayIndex, params.position)),
      details: params,
    }),
  });

  const getTool = defineTool({
    name: 'get_draft',
    label: '查看草稿',
    description: '查看当前行程草稿的紧凑全貌（含每个活动的位置编号）。',
    parameters: Type.Object({}),
    execute: async () => ({ content: text(draft.render()), details: {} }),
  });

  const moveTool = defineTool({
    name: 'move_activity',
    label: '调整活动日期',
    description: '把已有活动移到另一天下的末尾，保留活动 ID 与已解析地点。随后用 update_activity 调整时间，位置编号可用 get_draft 查看。',
    parameters: Type.Object({
      fromDayIndex: Type.Integer({ minimum: 1 }),
      activityId: Type.String({ minLength: 1 }),
      toDayIndex: Type.Integer({ minimum: 1 }),
    }),
    execute: async (_id, params) => {
      const moved = draft.moveActivityToDay(params.fromDayIndex, params.activityId, params.toDayIndex);
      return {
        content: text(moved ? `活动已移至第 ${params.toDayIndex} 天，请调整时间并重新检查可行性。` : '错误：原活动或目标天不存在，或目标天与原天相同。'),
        details: { moved },
      };
    },
  });

  // 住宿锚点（ST3）：用户未填住宿时由规划 Agent 建议一个区域（禁止具体酒店/价格，见 planner prompt）
  const lodgingTool = defineTool({
    name: 'set_lodging',
    label: '建议住宿区域',
    description: '记录建议的住宿区域（如「西湖景区周边」）。仅在用户未指定住宿位置时需要调用；禁止推荐具体酒店或价格。',
    parameters: Type.Object({
      name: Type.String({ description: '住宿区域名称，≤60 字，如「西湖景区周边」' }),
    }),
    execute: async (_id, params) => {
      const msg = draft.setLodging(params.name);
      return { content: text(msg), details: { name: params.name, isError: msg.startsWith('错误') } };
    },
  });

  // 可行性自查（M0-A）：返回当前草稿的时空违规清单，供 planner 提交前主动排雷（引擎在 @tripweaver/shared）。
  // 注意：坐标/leg 由 geoPipeline 在规划阶段结束后统一解析——本工具在解析前调用时只能算到已填坐标的活动，
  // 无坐标段标注「无法判定」跳过（R6），据此提示模型「留空坐标的活动待系统解析后再判」。
  // SOFT_CONVERGENCE_HINT：无硬性问题时追加收敛提示——实测模型会为一个 soft 缓冲提示空转 9 轮、76s（09-20 报告）
  const feasibilityTool = defineTool({
    name: 'check_feasibility',
    label: '可行性自查',
    description:
      '检查当前行程草稿的时空可行性（通勤是否排得下、单日是否过载、路线是否折返）。硬性问题必须修正才能 submit_plan；可优化提示不阻断提交，最多调整一次。',
    parameters: Type.Object({}),
    execute: async () => {
      const report = draft.feasibility();
      const hard = report.violations.filter((v) => v.severity === 'hard').length;
      const content = describeFeasibility(report);
      return {
        content: text(
          hard === 0
            ? `${content}\n\n（硬性问题 0 条：以上均为不阻断提交的可优化提示。最多再调整一次，随后立即 submit_plan，不要反复微调同一项。）`
            : content,
        ),
        details: { hard, soft: report.violations.length - hard },
      };
    },
  });

  // 文案专用写入口（第二期 D4）：结构由确定性排程决定，文案阶段只能改 description。
  // 用独立工具而不是让 update_activity 少传字段 —— 从工具面上杜绝「文案阶段偷偷改时间/顺序」。
  const describeTool = defineTool({
    name: 'update_description',
    label: '改写活动说明',
    description: '改写某天第 N 个活动的说明文案。只能改说明，不能改时间、名称、地点或活动数量。',
    parameters: Type.Object({
      dayIndex: Type.Integer({ description: '第几天（从 1 开始）' }),
      position: Type.Integer({ description: '第几个活动（从 1 开始，见 get_draft 输出）' }),
      description: Type.String({ description: '新说明，≤60 字：是什么 + 为什么值得去 + 实用提示' }),
    }),
    execute: async (_id, params) => {
      const msg = draft.updateActivity(params.dayIndex, params.position, { description: params.description });
      return {
        content: text(msg),
        details: { dayIndex: params.dayIndex, position: params.position, isError: msg.startsWith('错误') },
      };
    },
  });

  // 标题写入口（09-25）：文案阶段只负责行程标题与每天标题。
  // 活动说明不再由模型编写——research 阶段的候选 intro 已按同一标准写成（≤60 字），
  // buildDraft 直接把它用作活动 description，不需要第二次编写。
  // 用独立工具而不是复用 set_trip_skeleton：后者会重建 days 并清空已排好的活动。
  const titlesTool = defineTool({
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

  return [
    ...(mode === 'plan' ? [skeletonTool] : [moveTool]),
    addTool, updateTool, describeTool, titlesTool, removeTool, getTool, lodgingTool, feasibilityTool,
  ];
}

// 可行性硬门槛的自愈重试上限：连续 N 次仍有 hard 则放行（守生成不失败——剩余 hard 交修订轮/降级处理，
// 而非让 planner 在 submit_plan 死循环撞 maxTurns 导致任务失败）。计数随每轮 buildSubmitPlanTool 重建而重置。
const MAX_HARD_BLOCKS = 3;

/** submit_plan：完整性 + 可行性硬门槛闸门 —— 未通过时把问题清单回给模型自愈（R2/R3）。
 *  · 完整性问题（缺天/空天等）始终阻断；
 *  · 可行性 hard 问题阻断并回灌清单，连续 MAX_HARD_BLOCKS 次仍在则放行（避免撞 maxTurns 失败）；
 *  · soft 问题从不阻断，随审校清单/最终 reviewNotes 透出。
 *
 *  时序决策（M0-A）：submit_plan 发生在「本轮 geoPipeline 之前」，此刻草稿只有模型填的坐标、尚无 leg。
 *  门槛按「当下最好数据」判定——引擎对无 leg 段用 haversine 兜底（低置信），能拦住总时长超 14h、模型自填
 *  坐标下的 transit 排不下等硬伤；leg 缺失导致 anchor_missing 在此阶段被抑制（simulateTrip 靠 geocoded/legs
 *  推断解析是否已发生）。geoPipeline 跑完后 orchestrator 用真实 leg 重算，交审校与最终降级，权威判定在那里。 */
export function buildSubmitPlanTool(draft: DraftTrip, onPass: () => void): AgentTool {
  let hardBlocks = 0;
  return defineTool({
    name: 'submit_plan',
    label: '提交行程草稿',
    description: '行程填写完毕后提交校验。校验通过则规划阶段结束；未通过会返回问题清单，修正后重新提交。',
    parameters: Type.Object({}),
    execute: async () => {
      const problems = draft.validate();
      if (problems.length) {
        return { content: text(`校验未通过，请修正后重新 submit_plan：\n- ${problems.join('\n- ')}`), details: { pass: false, problems } };
      }
      const report = draft.feasibility();
      const hard = report.violations.filter((v) => v.severity === 'hard');
      if (hard.length && hardBlocks < MAX_HARD_BLOCKS) {
        hardBlocks += 1;
        return {
          content: text(`可行性硬性问题需修正后重新 submit_plan：\n${describeFeasibility(report)}`),
          details: { pass: false, hard: hard.length },
        };
      }
      onPass();
      return { content: text('校验通过，草稿已定稿。'), details: { pass: true, hardRemaining: hard.length }, terminate: true };
    },
  });
}
