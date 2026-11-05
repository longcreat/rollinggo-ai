# pi-agent-core / pi-ai 请求拦截点调研

日期：2026-09-20｜任务：09-20-llm-context-logging

## 结论

用 `Agent` 的 `streamFn` 选项包装默认 `streamSimple`，在调用前拿到 normalized 完整上下文。

## 依据（node_modules/@mariozechner 实测）

- `pi-agent-core/dist/agent.js`：`this.streamFn = options.streamFn ?? streamSimple`
  —— 不传 streamFn 时默认就是 pi-ai 的 `streamSimple`，包装后委托它即可保持行为一致。
- `pi-agent-core/dist/types.d.ts`：
  `StreamFn = (...args: Parameters<typeof streamSimple>) => ReturnType<typeof streamSimple> | Promise<...>`
- `pi-ai/dist/stream.d.ts`：`streamSimple(model, context: Context, options?: SimpleStreamOptions)`
  —— `Context = { systemPrompt, messages, tools }`，正是要记录的三要素。

## 备选方案对比

| 方案 | 内容 | 取舍 |
|---|---|---|
| `streamFn` 包装（选定） | normalized context（systemPrompt/messages/tools） | 与 wire 格式无关，结构干净；响应需另从 message_end 拿 |
| `Agent.onPayload` | 提供商原始 wire payload（可改写） | 最贴近实际发送内容，但格式随 provider 变；且语义是「可替换 payload」，只读记录有点越界 |
| `Agent.onResponse` | HTTP 响应头/状态，body 未消费 | 拿不到响应正文，单独用不够 |

## 响应捕获

runner.ts 已订阅 agent `message_end` 事件提取 usage/errorMessage；
同一处扩展：把 stopReason/usage/errorMessage/text 回写到该 turn 的记录行。
assistant 消息本身会出现在下一 turn 的 messages 快照里，最后一轮的响应靠这次回写补齐。

## 注意

- context.messages 为纯数据对象，jsonb 落库直接 JSON 序列化即可。
- API key 走 `getApiKey` 回调，不进 context —— 快照天然不含密钥。
- streamFn 每次 API 请求都会调用（含单阶段多 turn），turn 计数在 runner 内递增。
