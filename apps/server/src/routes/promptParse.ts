// 首页自然语言意图理解路由：从自然语言描述中极速提炼出行意图并生成顾问回复
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { env, hasSiteLlm } from '@tripweaver/core/env';
import { PREFERENCE_OPTIONS, PACE_OPTIONS } from '@tripweaver/shared';

const PromptParseRequestSchema = Type.Object({
  prompt: Type.String({ minLength: 1, maxLength: 500 }),
  current: Type.Optional(
    Type.Object({
      destination: Type.Optional(Type.String()),
      days: Type.Optional(Type.Integer()),
      startDate: Type.Optional(Type.String()),
      endDate: Type.Optional(Type.String()),
      pace: Type.Optional(Type.String()),
      partySize: Type.Optional(Type.Integer()),
      preferences: Type.Optional(Type.Array(Type.String())),
      extraNotes: Type.Optional(Type.String()),
    }),
  ),
});

const PromptParseResponseSchema = Type.Object({
  destination: Type.String(),
  days: Type.Integer(),
  startDate: Type.String(),
  endDate: Type.String(),
  pace: Type.String(),
  partySize: Type.Integer(),
  preferences: Type.Array(Type.String()),
  extraNotes: Type.String(),
  reply: Type.String(),
});

function computeDates(days: number): { startDate: string; endDate: string } {
  const d = new Date();
  d.setDate(d.getDate() + 1); // 默认明天出发
  const start = d.toISOString().slice(0, 10);
  d.setDate(d.getDate() + days - 1);
  const end = d.toISOString().slice(0, 10);
  return { startDate: start, endDate: end };
}

export const promptParseRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // 公开接口，允许首页未登录访客体验自然语言行程规划
  app.post(
    '/parse-prompt',
    {
      // 公开端点且消耗站点 LLM 额度，必须限流；request.ip 的真实性由 index.ts 的 trustProxy 保证
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: PromptParseRequestSchema,
        response: { 200: PromptParseResponseSchema },
      },
    },
    async (request, reply) => {
      const { prompt, current } = request.body;
      const defaultDays = current?.days && current.days >= 1 && current.days <= 7 ? current.days : 3;
      const defaultPace = current?.pace && (PACE_OPTIONS as readonly string[]).includes(current.pace) ? current.pace : 'moderate';
      const defaultPartySize = current?.partySize ?? 2;
      const defaultDestination = current?.destination ?? '';
      const defaultNotes = current?.extraNotes ?? '';
      const defaultPreferences = current?.preferences ?? [];

      if (!hasSiteLlm()) {
        const dates = computeDates(defaultDays);
        return reply.send({
          destination: defaultDestination || '',
          days: defaultDays,
          startDate: current?.startDate || dates.startDate,
          endDate: current?.endDate || dates.endDate,
          pace: defaultPace,
          partySize: defaultPartySize,
          preferences: defaultPreferences,
          extraNotes: defaultNotes || prompt.slice(0, 100),
          reply: '收到您的出行想法，已为您同步调整行程参数！',
        });
      }

      const systemPrompt = `你是一个专业的旅行规划顾问。用户会用自然语言描述他们的出行想法或修改要求。
你的任务是从输入中提炼结构化参数，并给出亲切简短的规划回复。
严禁使用任何 Emoji 表情符号（禁止出现诸如 🐼🍜🌸🎒 等任何表情），所有文本必须为优雅、专业的纯中文。
合法偏好标签只准从以下挑选：${PREFERENCE_OPTIONS.join('、')}。
节奏 pace 只能是：relaxed（慢节奏/躺平/不累/老人/带娃/度假）, moderate（适中/经典/全景体验）, tight（紧凑/特种兵/高效打卡）。
天数 days 限制为 1 到 7 的整数。
目的地 destination 必须是纯正城市或地级市/旅游县名（例如：成都、大理、西安、杭州、三亚、青岛、丽江），不要带"市"、"古城"、"景区"等后缀。

请以严格的 JSON 格式输出：
{
  "destination": "目的地城市名",
  "days": 3,
  "pace": "relaxed" | "moderate" | "tight",
  "partySize": 2,
  "preferences": ["美食", "文化"],
  "extraNotes": "关键游玩偏好、特定想去景点或特殊要求",
  "reply": "针对用户的个性化提炼回复（45字以内，亲切有吸引力，严禁使用任何 emoji 表情）"
}`;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(`${env.siteLlm.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.siteLlm.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: env.siteLlm.model || 'deepseek-flash',
            temperature: 0.1,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: systemPrompt },
              ...(current?.destination ? [{ role: 'system', content: `当前已暂存上下文：目的地「${current.destination}」，天数「${current.days ?? 3}天」，偏好「${current.preferences?.join(',') || '无'}」。若用户未提及修改某项则保留。` }] : []),
              { role: 'user', content: prompt },
            ],
          }),
          signal: controller.signal,
        }).finally(() => clearTimeout(timeout));

        if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const content = data.choices?.[0]?.message?.content?.trim() ?? '{}';
        const parsed = JSON.parse(content) as Record<string, unknown>;

        const rawDays = typeof parsed.days === 'number' && Number.isInteger(parsed.days) ? parsed.days : defaultDays;
        const days = Math.min(Math.max(rawDays, 1), 7);
        const dates = computeDates(days);

        const rawPace = typeof parsed.pace === 'string' ? parsed.pace.toLowerCase() : '';
        const pace = (PACE_OPTIONS as readonly string[]).includes(rawPace) ? rawPace : defaultPace;

        const rawPartySize = typeof parsed.partySize === 'number' && Number.isInteger(parsed.partySize) ? parsed.partySize : defaultPartySize;
        const partySize = Math.min(Math.max(rawPartySize, 1), 20);

        const rawDestination = typeof parsed.destination === 'string' ? parsed.destination.trim().replace(/(市|地区|盟|特别行政区)$/, '') : '';
        const destination = rawDestination || defaultDestination || '';

        const rawPrefs = Array.isArray(parsed.preferences) ? parsed.preferences : [];
        const preferences = rawPrefs
          .filter((p): p is string => typeof p === 'string')
          .filter((p) => (PREFERENCE_OPTIONS as readonly string[]).includes(p as (typeof PREFERENCE_OPTIONS)[number]))
          .slice(0, 5);

        const extraNotes = typeof parsed.extraNotes === 'string' ? parsed.extraNotes.slice(0, 200) : defaultNotes;
        const replyText = typeof parsed.reply === 'string' && parsed.reply.trim()
          ? parsed.reply.trim().slice(0, 80)
          : `已为您定制【${destination}】${days}天行程框架，点击立即开始规划！`;

        return reply.send({
          destination,
          days,
          startDate: dates.startDate,
          endDate: dates.endDate,
          pace,
          partySize,
          preferences: preferences.length > 0 ? preferences : defaultPreferences,
          extraNotes,
          reply: replyText,
        });
      } catch (err) {
        // 模型请求偶发失败时优雅兜底，不阻断用户交互
        const dates = computeDates(defaultDays);
        return reply.send({
          destination: defaultDestination || '',
          days: defaultDays,
          startDate: dates.startDate,
          endDate: dates.endDate,
          pace: defaultPace,
          partySize: defaultPartySize,
          preferences: defaultPreferences,
          extraNotes: prompt.slice(0, 100),
          reply: '收到！已为您提取出行信息，您可以直接开始生成或在下方微调。',
        });
      }
    },
  );
};
