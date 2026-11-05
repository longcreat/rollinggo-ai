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

function researchCalls(turnHasToolResults) {
  if (turnHasToolResults) {
    return [{ name: 'submit_research', args: { summary: '（来自模型知识）候选已入池：故宫博物院、测试食堂、测试酒店。建议第 1 天集中在市中心。' } }];
  }
  // 覆盖新工具面：地点搜索 + 攻略搜索 + 候选写入（含预约种子表命中与同名去重）
  return [
    { name: 'search_pois', args: { category: 'attraction', keyword: '必去景点' } },
    { name: 'search_web', args: { query: '攻略 预约' } },
    { name: 'add_candidate', args: { name: '故宫博物院', category: 'attraction', intro: '明清两代皇宫，世界文化遗产。', reservation: 'none' } },
    { name: 'add_candidate', args: { name: '测试食堂', category: 'food', intro: '本地人气小馆，招牌菜实惠。', reservation: 'unknown' } },
    { name: 'add_candidate', args: { name: '测试酒店', category: 'hotel', intro: '交通便利的舒适型酒店。' } },
    { name: 'add_candidate', args: { name: '故宫博物院', category: 'attraction', intro: '重复添加应被去重。' } },
  ];
}

function plannerCalls(days, turnHasToolResults, { geocodedActivities, includeLodging }) {
  if (turnHasToolResults) return [{ name: 'submit_plan', args: {} }];
  const calls = [
    { name: 'set_trip_skeleton', args: { title: '测试之旅', dayTitles: Array.from({ length: days }, (_, i) => `第${i + 1}天主题`) } },
  ];
  // ST3 住宿锚点：用户未指定时建议一个区域（用户已指定时工具幂等返回提示，不报错）
  if (includeLodging) calls.push({ name: 'set_lodging', args: { name: '市中心站前区域' } });
  for (let d = 1; d <= days; d++) {
    const activities = [
      { name: `活动${d}-1`, placeName: `活动${d}-1`, startTime: '09:00', endTime: '11:00', category: '文化' },
      { name: `午餐｜活动${d}-1周边当地风味`, startTime: '12:00', endTime: '13:15', category: '美食' },
      { name: `晚餐｜市中心片区当地风味`, startTime: '18:00', endTime: '19:15', category: '美食' },
    ];
    for (const [j, activity] of activities.entries()) {
      calls.push({
        name: 'add_activity',
        args: {
          dayIndex: d,
          ...activity,
          description: activity.category === '美食'
            ? '建议选择所在片区的当地菜系或代表菜，具体门店与实时信息到本地生活平台确认。'
            : '测试活动描述',
          lat: 35.68 + d * 0.01 + j * 0.001,
          lng: 139.76 + d * 0.01 + j * 0.001,
          ...(geocodedActivities ? { coordSource: 'geocoded' } : {}),
        },
      });
    }
  }
  return calls;
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
      const days = Number(/天数：(\d+) 天/.exec(userText)?.[1] ?? 2);

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
      } else if (system.includes('行程规划师') && system.includes('局部修订')) {
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
      } else if (system.includes('行程规划师')) {
        respondWithToolCalls(res, payload.model, plannerCalls(days, toolResults > 0, { geocodedActivities, includeLodging }));
      } else if (system.includes('旅行建议撰写员')) {
        if (adviceResponse === 'error') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'mock advice failure', type: 'invalid_request_error' } }));
          return;
        }
        const { finalItinerary, evidence } = JSON.parse(userText);
        const day = finalItinerary.days.find(day => day.activities.length);
        const activity = day.activities[0];
        const evidenceIds = evidence.filter(e => e.activityIds.includes(activity.id)).slice(0, 2).map(e => e.id);
        respondWithToolCalls(res, payload.model, [{ name: 'submit_trip_advice', args: {
          suggestions: [{ title: '按当天体力慢游', text: `第${day.dayIndex}天游览${activity.name}时留出停留与休息时间。`, activityIds: [activity.id], evidenceIds }],
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
