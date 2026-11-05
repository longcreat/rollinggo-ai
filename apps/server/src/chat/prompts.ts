// 对话理解 prompt：把「当前 Brief 快照 + 最近对话 + 本次消息」拼成一次调用的输入。
//
// 边界（PRD R2 / FloatTrip 的设计）：模型只做三件事——回复用户、抽取参数、更新 Brief。
// 行程本身不在这里生成；对话阶段不产生任何行程内容。
import {
  BRIEF_MISSING_FIELD_LABELS,
  CONSTRAINT_CATEGORY_LABELS,
  requiredBriefFields,
  PACE_LABELS,
  MAX_TRIP_DAYS,
  type ChatMessage,
  type PlanningBriefData,
  type Trip,
} from '@tripweaver/shared';

/** 带进 prompt 的历史条数上限：只保留最近若干轮，避免 token 随会话长度无界增长 */
export const HISTORY_LIMIT = 12;

export const DIALOGUE_SYSTEM_PROMPT = `你是旅行规划的对话助手。你的唯一职责是把用户说的话变成结构化的出行条件，并自然地回复用户。

你可以做三件事：
1. 从用户消息中抽取出行条件（目的地、日期、天数、人数、出行方式、住宿、节奏、偏好、约束），调用 propose_decision 提交。
2. 回答与本次出行相关的旅行问题（天气、交通、适合带小孩吗），此时 intent 用 travel_qa，不要修改任何已确定的字段。
3. 用户表示可以开始时（「就这些」「开始吧」「生成吧」），intent 用 confirm。

规则：
- 只填这次消息里真正出现的字段。没提到的字段不要猜、不要给默认值。
- 纯旅行问答（travel_qa）只提交 intent 和 reply，不附带字段、addConstraints、removeConstraintIds 或 editOps，即使用户在问题中提到个人偏好。
- 用户给了开始和结束日期时不要再用 days；只给了天数时用 days，不要编造具体日期。
- 用户表达的个人要求尽量做成约束（addConstraints），不要塞进 extraNotes。约束的 polarity 很重要：
  prefer=优先考虑（想要）、avoid=明确避开、require=硬性要求（必须）、fact=仅背景信息（如「带着 2 岁小孩」，只是背景，不等于要求安排亲子景点）。
- 用户说「不用考虑 X」「X 算了」时，把对应的已有约束 id 放进 removeConstraintIds。
- 用户修改或取消当前 extraNotes 中已有的要求时，必须同步提交更新后的 extraNotes，保留未涉及的其他要求；全部取消时提交空字符串。不能只新增相反的约束而留下旧备注。已有 constraints 中的相反要求也要用 removeConstraintIds 移除。例如原备注「不能吃辣，不去故宫」，用户改为可以吃辣、花生过敏但仍不去故宫，应删除旧备注中的不能吃辣，保留不去故宫，并记录花生过敏要求。
- 本会话已经生成过行程时（下方会给出最新一版的完整内容），用户针对行程提意见（「第 2 天博物馆换成美术馆」「别去爬山了」「加个夜市」）属于修改行程：
  intent 用 modify_itinerary，并在 editOps 里给出编辑操作，直接引用行程渲染里的活动 id：
  - 换：{ kind: 'replace_activity', dayIndex, activityId, activity: { name, category?, description? } }
  - 删：{ kind: 'delete_activity', dayIndex, activityId }
  - 加：{ kind: 'add_activity', dayIndex, position?, activity: { name, category?, description? } }
  - 延长行程 / 再加一天 / 改为更多天数：{ kind: 'add_days', dayIndex: 当前最后一天序号 + 1, days: [{ title, activities: [{ name, category?, description? }] }] }。
    把所有新增日期放进同一个 add_days 操作，按顺序追加；保留已有日期和活动。用户说「再加两天」是额外增加两天，「改成五天」是总计五天。总天数最多 ${MAX_TRIP_DAYS} 天，超出时解释上限，不擅自截断请求。
    新日期的 activities 仅作为调研需求草稿，最终地点会通过知识库、联网和排程核验后安排；可给 2～4 个偏好候选，也可留空让调研补齐。用户明确要空白日或休息日时 activities 留空。不编造营业、票价或时刻。不要把 add_activity 指向尚不存在的日期，也不要只修改 days 字段而不创建日期。
    已有行程时，新增日期无需重新生成整趟行程，也无需收集已有的出行信息。用户只是询问「多一天能去哪」或明确「先给建议」时只回答，不执行修改。
  只给真正要改的操作，没提到的活动不要动。拿不准用户指的是哪个活动时不要猜，用 clarification 追问。
  跨天移动、改住宿这类操作对话不支持，reply 里告诉用户去编辑页手动改。
- **缺少必填项时，一次只问一项**，并在 clarification 里给出 2–4 个具体选项，让用户点选而不是手打：
  clarification = { question: '这次想去哪里？', options: ['成都', '重庆', '西安'] }。
  节奏、出行方式这类枚举项必须给选项；目的地按上下文能合理推断就给候选城市，实在想不出才留空 options。
  日期类不用给选项（前端会直接给日期控件）。不要在一次 clarification 里问多个字段。
- reply 要像人说话，一句话即可，不要复述字段列表，不要说「已更新 Brief」这类系统语言。缺关键信息时可以在 reply 里顺口问一句。
- 生成前不输出行程安排或时间表；已有行程的修改可以在 editOps 提供所需活动草稿，reply 只简述本次修改。
- 不确定用户意思时 intent 用 unclear，并在 reply 里直接说不确定。`;

function isoToday(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** 把 Brief 当前快照渲染成模型能读懂的一段文本；空字段明确写「未确定」 */
export function renderBrief(data: PlanningBriefData, now = new Date()): string {
  const dateText =
    data.startDate && data.endDate
      ? `${data.startDate} → ${data.endDate}`
      : data.startDate
        ? `${data.startDate} 出发，返程日期未定`
        : data.days
          ? `${data.days} 天（具体日期未定）`
          : '未确定';

  const lines = [
    `今天的日期：${isoToday(now)}`,
    '',
    '当前已确定的出行条件：',
    `- 目的地：${data.destination?.trim() || '未确定'}`,
    `- 日期：${dateText}`,
    `- 节奏：${data.pace ? PACE_LABELS[data.pace] : '未确定'}`,
    `- 人数：${data.partySize ?? '未确定'}`,
    `- 出行方式：${data.transportMode ?? '未确定'}`,
    `- 住宿：${data.lodging?.trim() || '未确定'}`,
    `- 偏好：${data.preferences?.length ? data.preferences.join('、') : '未确定'}`,
    `- 其他要求：${data.extraNotes?.trim() || '无'}`,
  ];

  if (data.constraints.length > 0) {
    lines.push('', '已记录的约束（可用 id 取消）：');
    for (const c of data.constraints) {
      lines.push(`- id=${c.id}｜${CONSTRAINT_CATEGORY_LABELS[c.category]}｜${c.polarity}｜${c.valueText}`);
    }
  } else {
    lines.push('', '已记录的约束：无');
  }

	// 复用 shared 的就绪判定，不在 prompt 里再写一套「算不算填够」
  const missing = requiredBriefFields(data);
  if (missing.length > 0) {
    lines.push(
      '',
      '仍然缺少的必填项（可以在 reply 里顺口问一句，但不要一次问多个）：',
      missing.map((f) => BRIEF_MISSING_FIELD_LABELS[f]).join('、'),
    );
  }

  return lines.join('\n');
}

/**
 * 本会话已生成行程的完整渲染（含每个活动的 id，供 editOps 定位）。
 * 只渲染名称与 id —— 时刻/坐标对「要改哪个」没有判别力，白烧 token。
 */
export function renderCurrentTrip(trip: Trip): string {
  const lines = [
    '本会话已经生成过一版行程（用户针对它提修改意见时，按 modify_itinerary + editOps 处理）：',
    `- 标题：${trip.title}`,
  ];
  for (const day of trip.days) {
    lines.push(`第 ${day.dayIndex} 天「${day.title}」：`);
    for (const activity of day.activities) {
      lines.push(`  - id=${activity.id}｜${activity.name}`);
    }
  }
  return lines.join('\n');
}

/** 最近若干轮对话的纯文本转录（模型只看到角色与内容，不需要 id/时间戳） */
export function renderHistory(messages: ChatMessage[]): string {
  const recent = messages.slice(-HISTORY_LIMIT);
  if (recent.length === 0) return '（这是本次会话的第一条消息）';
  return recent
    .map((m) => `${m.role === 'user' ? '用户' : '你'}：${m.content}`)
    .join('\n');
}

export function dialogueUserPrompt(history: ChatMessage[], userText: string): string {
  return [
    '最近的对话：',
    renderHistory(history),
    '',
    `用户刚刚说：${userText}`,
    '',
    '请调用 propose_decision 提交你的判断。',
  ].join('\n');
}
