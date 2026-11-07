// mock OpenAI 兼容端点：按 system prompt 关键词分阶段回放工具调用（verify-c2 / verify-c3 共用）
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import crypto from 'node:crypto';

function sseChunk(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function respondWithToolCalls(res, model, calls) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
  sseChunk(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  const tool_calls = calls.map((c, i) => ({
    index: i,
    id: `call_${crypto.randomUUID().slice(0, 8)}`,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.args) },
  }));
  sseChunk(res, { ...base, choices: [{ index: 0, delta: { tool_calls }, finish_reason: null }] });
  sseChunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  sseChunk(res, { ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

function respondWithText(res, model, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
  sseChunk(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
  sseChunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  sseChunk(res, { ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

function researchCalls(turnHasToolResults) {
  if (turnHasToolResults) {
    return [{ name: 'submit_research', args: { summary: '（来自模型知识）候选已入池：故宫博物院、测试食堂、测试酒店。建议第 1 天集中在市中心。' } }];
  }
  // 覆盖新工具面：地点搜索 + 攻略搜索 + 候选写入（含预约种子表命中与同名去重）
  return [
    { name: 'search_pois', args: { category: 'attraction', keyword: '必去景点' } },
    { name: 'search_web', args: { query: '攻略 预约' } },
    { name: 'add_candidate', args: { name: '故宫博物院', category: 'attraction', intro: '明清两代皇宫，世界文化遗产。', reservation: 'none' } },
    { name: 'add_candidate', args: { name: '天安门广场', category: 'attraction', intro: '城市中轴线上的开放广场。', reservation: 'none' } },
    { name: 'add_candidate', args: { name: '景山公园', category: 'attraction', intro: '登高俯瞰中轴线的城市公园。', reservation: 'none' } },
    { name: 'add_candidate', args: { name: '测试食堂', category: 'food', intro: '本地人气小馆，招牌菜实惠。', reservation: 'unknown' } },
    { name: 'add_candidate', args: { name: '测试酒店', category: 'hotel', intro: '交通便利的舒适型酒店。' } },
    { name: 'add_candidate', args: { name: '故宫博物院', category: 'attraction', intro: '重复添加应被去重。' } },
  ];
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  return '';
}

/** 当前规划协议：list_areas → plan_day（每天） → submit_plan。工具结果决定下一步。 */
function plannerCalls(days, messages) {
  const toolTexts = messages.filter((message) => message.role === 'tool').map(messageText);
  const areasText = toolTexts.find((text) => text.includes('"areas"'));
  if (!areasText) return [{ name: 'list_areas', args: {} }];

  let areas = [];
  try {
    const start = areasText.indexOf('{');
    const end = areasText.lastIndexOf('}');
    areas = JSON.parse(areasText.slice(start, end + 1)).areas ?? [];
  } catch {
    areas = [];
  }
  // plan_day 至少 2 个地点：优先选候选足够多的片区，否则跨片区拼。
  const area = areas.find((item) => (item.candidates?.length ?? 0) >= 2) ?? areas[0];
  if (!area) return [{ name: 'submit_plan', args: {} }];

  const alreadyPlanned = toolTexts.some((text) => text.includes('"totalMinutes"') || text.includes('"dayIndex"'));
  if (alreadyPlanned) return [{ name: 'submit_plan', args: {} }];

  const places = area.candidates.length >= 2
    ? area.candidates.slice(0, 3)
    : areas.flatMap((item) => item.candidates ?? []).slice(0, 3);
  return Array.from({ length: days }, (_, index) => ({
    name: 'plan_day',
    args: { dayIndex: index + 1, areaId: area.id, places, startAt: '09:00' },
  }));
}

/**
 * 启动 mock 端点；返回 { server, seenAuthHeaders, seenRevisions, close }
 * delayMs：每次补全前的延迟（留出取消窗口 / 模拟真实节奏）
 */
export async function startMockLlm(
  port,
  { delayMs = 300, reviewerOverrunOnce = false, requestRevisionOnce = false, geocodedActivities = false, includeLodging = true } = {},
) {
  const seenAuthHeaders = [];
  const seenRevisions = [];
  // 调研阶段 system prompt 快照（按目的地记）：验证 search_web 上限随城市覆盖动态注入（09-25 R3）
  const seenResearchPrompts = [];
  let seenWriter = null;
  let adviceResponse = 'tool';
  let reviewerOverrunAvailable = reviewerOverrunOnce;
  let reviewerOverrunActive = false;
  let reviewerRevisionAvailable = requestRevisionOnce;
  let reviewerRevisionActive = false;
  const server = createServer((req, res) => {
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      await sleep(delayMs);
      seenAuthHeaders.push(req.headers.authorization ?? '');
      const payload = JSON.parse(body);
      const system = payload.messages.find((m) => m.role === 'system')?.content ?? '';
      const toolResults = payload.messages.filter((m) => m.role === 'tool').length;
      // content 可能是字符串或 [{type:'text',text}] 数组（pi-ai 按 OpenAI 规范发数组）
      const rawUser = payload.messages.find((m) => m.role === 'user')?.content;
      const userText = typeof rawUser === 'string' ? rawUser : Array.isArray(rawUser) ? rawUser.map((c) => c?.text ?? '').join('\n') : '';
      // 规划/调研的 system prompt 写「天数：3；」，旧 userText 里是「3 天」；两者都认。
      const days = Number(/天数[:：](\d+)/.exec(`${system}\n${userText}`)?.[1] ?? /(\d+)\s*天/.exec(userText)?.[1] ?? 2);

      if (system.includes('行前规划助手')) {
        // 行前回合可以只回文本：表单 autostart 会按条件确定性委派生成。
        respondWithText(res, payload.model, '已在后台开始生成，可在任务里查看进度。');
        return;
      }
      if (system.includes('对话助手')) {
        // 问答式入口（09-23）：单轮工具调用，不带多轮工具链。
        // fixture 标记「先不定日期」：故意不给出发日期，用来验证「缺字段 → 给可点选控件」。
        const said = /用户刚刚说：([^\n]*)/.exec(userText)?.[1] ?? '';
        const KNOWN_CITIES = ['东京', '大阪', '北京', '上海', '成都', '杭州', '重庆'];
        const destination = KNOWN_CITIES.find((city) => said.includes(city)) ?? '成都';
        const days = Number(/(\d+)\s*天/.exec(said)?.[1] ?? 3);
        const omitDate = said.includes('先不定日期');
        // 针对已有行程的修改意见「换成/改成/别去」→ modify_itinerary + editOps（09-24 R1：按需编辑，不再整单重跑）。
        // activityId 从 system prompt 的行程渲染（id=xxx｜名称）里取目标天的第一个活动
        const isModification = /换成|改成|别去/.test(said);
        const modificationDecision = () => {
          const dayM = /第\s*(\d+)\s*天/.exec(said);
          const dayIndex = dayM ? Number(dayM[1]) : 1;
          const lines = system.split('\n');
          const dayStart = lines.findIndex((l) => l.startsWith(`第 ${dayIndex} 天`));
          const idLine = dayStart >= 0 ? lines.slice(dayStart + 1).find((l) => l.includes('id=')) : undefined;
          const activityId = idLine ? /id=([^｜\s]+)｜/.exec(idLine)?.[1] : undefined;
          return {
            intent: 'modify_itinerary',
            reply: '好的，换成博物馆。',
            ...(activityId
              ? { editOps: [{ kind: 'replace_activity', dayIndex, activityId, activity: { name: '成都博物馆', category: '文化' } }] }
              : {}),
          };
        };
        // 还不知道去哪：不给 destination，改用 clarification.options 给可点候选（PR6 修正）
        const askDestination = /不知道去哪/.test(said) && !KNOWN_CITIES.some((city) => said.includes(city));
        respondWithToolCalls(res, payload.model, [{
          name: 'propose_decision',
          args: askDestination
            ? {
              intent: 'update_brief',
              reply: '没问题，先定个方向？',
              clarification: { question: '这次想去哪里？', options: ['成都', '重庆', '西安'] },
            }
            : isModification
              ? modificationDecision()
              : {
                // confirm 只在用户表达「出发/开始/生成」时给出 —— R3 自动触发以 confirm 为准，
                // 普通补全字段（如「成都吧」）保持 update_brief，不该误触发生成
                intent: omitDate ? 'update_brief' : (/出发|开始|生成/.test(said) ? 'confirm' : 'update_brief'),
                reply: omitDate
                  ? `好的，${destination}记下了，大概什么时候出发？`
                  : `好的，${destination} ${days} 天记下了，可以开始生成了。`,
                destination,
                days,
                pace: 'moderate',
                transportMode: 'transit',
                ...(omitDate ? {} : { startDate: '2026-11-05' }),
                addConstraints: [{ category: 'companion_context', valueText: '带 2 岁小孩', polarity: 'fact' }],
              },
        }]);
      } else if (system.includes('旅行调研员')) {
        // 快照调研 prompt 中 search_web 上限行：验证随城市覆盖动态注入（09-25 R3）
        const destination = /目的地：(.+?)｜/.exec(userText)?.[1] ?? '';
        seenResearchPrompts.push({ destination, searchWebMaxLine: /全阶段最多 \d+ 次/.exec(system)?.[0] ?? '',
          hasPrefetch: userText.includes('系统已预取以下已验证候选') && userText.includes('id=') });
        const prefetched = [...userText.matchAll(/^id=([^｜\n]+)｜([^｜\n]+)/gm)].slice(0, days * 3);
        respondWithToolCalls(res, payload.model, prefetched.length
          ? [{ name: 'submit_research', args: { candidates: prefetched.map(([, placeId, name]) => ({ placeId, intro: `${name}适合漫步参观。` })) } }]
          : researchCalls(toolResults > 0));
      } else if (system.includes('行程规划') && system.includes('局部修订')) {
        if (toolResults === 0) {
          seenRevisions.push({
            tools: (payload.tools ?? []).map((tool) => tool.function?.name),
            hasDraft: userText.includes('当前草稿'),
            activityIds: [...userText.matchAll(/｜id=([^｜\s]+)｜/g)].map((match) => match[1]),
          });
        }
        respondWithToolCalls(res, payload.model, toolResults > 0
          ? [{ name: 'submit_plan', args: {} }]
          : [{ name: 'update_activity', args: { dayIndex: 1, position: 1, startTime: '09:30', description: '局部修订：延后半小时参观，保留其他安排。' } }]);
      } else if (system.includes('行程规划')) {
        // 提交成功后用纯文本收尾，避免 mock 在轮次上限内反复 submit。
        const submitted = payload.messages
          .filter((message) => message.role === 'tool')
          .map(messageText)
          .some((text) => text.includes('已提交') || text.includes('"ok":true'));
        if (submitted) respondWithText(res, payload.model, '规划完成');
        else respondWithToolCalls(res, payload.model, plannerCalls(days, payload.messages));
      } else if (system.includes('旅行建议撰写员')) {
        if (adviceResponse === 'error') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'mock advice failure', type: 'invalid_request_error' } }));
          return;
        }
        const { finalItinerary, evidence } = JSON.parse(userText);
        const allActivities = finalItinerary.days.flatMap((day) => day.activities);
        // 优先引用 SQL 知识库里注入的证据，并把它挂到真实行程活动上。
        const sqlEvidence = evidence.find((item) => item.sources?.some((source) => source.url === 'https://example.com/palace-evidence'));
        const matched = sqlEvidence
          ? allActivities.find((item) => sqlEvidence.activityIds.includes(item.id))
          : allActivities.find((item) => evidence.some((e) => e.activityIds.includes(item.id)));
        const activity = matched ?? allActivities[0];
        const dayIndex = finalItinerary.days.find((day) => day.activities.some((item) => item.id === activity.id))?.dayIndex ?? 1;
        const evidenceIds = sqlEvidence ? [sqlEvidence.id] : evidence.filter(e => e.activityIds.includes(activity.id)).slice(0, 2).map(e => e.id);
        respondWithToolCalls(res, payload.model, [{ name: 'submit_trip_advice', args: {
          suggestions: [{ title: '按当天体力慢游', text: `第${dayIndex}天游览${activity.name}时留出停留与休息时间。`, activityIds: [activity.id], evidenceIds }],
          cautions: [{ title: '核实参观要求', text: `${activity.name}的预约与入场规则请以官方最新信息为准。`, activityIds: [activity.id], evidenceIds }],
        } }]);
      } else if (system.includes('行程标题撰写员')) {
        // 09-25：文案阶段只写标题，活动说明直接复用候选 intro（不再经模型二次编写）
        if (toolResults === 0) {
          seenWriter = {
            tools: (payload.tools ?? []).map((tool) => tool.function?.name).sort(),
            hasDraft: userText.includes('当前行程'),
          };
        }
        respondWithToolCalls(res, payload.model, [{ name: 'update_titles', args: {
              title: '测试行程标题',
              dayTitles: Array.from({ length: days }, (_, i) => `第${i + 1}天主题`),
              notes: ['测试建议：留意闭馆时间'],
            } }]);
      } else if (system.includes('行程审校员')) {
        if (toolResults === 0) {
          reviewerOverrunActive = reviewerOverrunAvailable;
          reviewerOverrunAvailable = false;
          reviewerRevisionActive = !reviewerOverrunActive && reviewerRevisionAvailable;
          if (reviewerRevisionActive) reviewerRevisionAvailable = false;
        }
        respondWithToolCalls(
          res,
          payload.model,
          reviewerOverrunActive
            ? [{ name: 'get_draft', args: {} }]
            : [{ name: 'submit_review', args: {
              approved: !reviewerRevisionActive,
              notes: ['测试建议：留意闭馆时间'],
              revisionRequests: reviewerRevisionActive ? ['第 1 天第 1 项开始时间调至 09:30，并补充参观说明；保留其他安排。'] : [],
            } }],
        );
      } else {
        respondWithToolCalls(res, payload.model, [{ name: 'submit_research', args: { summary: '兜底' } }]);
      }
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { server, seenAuthHeaders, seenRevisions, seenResearchPrompts, get seenWriter() { return seenWriter; },
    setAdviceResponse(value) { adviceResponse = value; }, close: () => server.close() };
}
