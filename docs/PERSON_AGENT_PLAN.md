# 行程详情「个人 Agent」升级方案（复用优先版）

> 状态：规划稿，未实施
> 原则：能用现成 harness 的就装、能整段搬的就搬，自写只保留旅行领域相关的薄层。
> 目标：详情页对话升级为能连续干活的 Agent——多轮工具、联网搜索、记忆、弹窗追问、行程增删改查，可中断、可恢复。

## 1. 结论先行

**底座换成 pi 1.5 家族，运行时直接引入 `@earendil-works/pi-durable`，只自写旅行工具和提交钩子。**

理由：`pi-durable` 已经把我上一版方案里 P0/P3/P4 的大部分工作做完了——durable run、崩溃恢复、compaction、工具任务重试、会话 watch（给 UI 的事件流）、子任务、每会话 agent 配置。这些自建要 1500 行以上，而且很难做对。

自写范围缩小到约 1800 行，全部是旅行领域的东西：DraftTrip、12 个工具、版本提交、SSE 桥、前端卡片。

代价是引入一个 experimental 依赖和一套新概念（chord 文档模型、storage 适配）。用 2 天 POC 做门槛，不通过就退回自建 runtime（见 §10）。

## 2. 复用分三层

| 层 | 做法 | 范围 |
| --- | --- | --- |
| A 直接依赖 | `npm i`，写胶水 | 运行时、agent 循环、LLM 适配、工具 schema |
| B 整段搬 | 复制源码 / 提示词，改 import | ask_user 语义、压缩提示词、工具结果截断、权限规则 |
| C 自写 | 无法复用 | 旅行工具、DraftTrip、版本提交、SSE 桥、前端 |

判断标准：**运行时和会话状态一律不自研**；**领域语义（行程怎么改、版本怎么落）必须自写**。

## 3. 选型：pi 1.5 家族

当前项目用的是 `@mariozechner/pi-agent-core` / `@mariozechner/pi-ai` 0.73.0。上游已经改名并发布 1.5.0：

| 包 | 版本 | 作用 | 处理 |
| --- | --- | --- | --- |
| `@earendil-works/pi-ai` | 1.5.0 | LLM 适配、Model、stream 事件 | 升级替换 |
| `@earendil-works/pi-agent-core` | 1.5.0 | Agent 循环、steer/followUp/continue | 升级替换 |
| `@earendil-works/pi-durable` | 1.5.0 | durable 会话、工具任务、compaction、watch | 新增 |
| `@earendil-works/chord` | 1.5.0 | pi-durable 的文档状态底座 | 传递依赖，不直接用 |

迁移面已验证：

- `Agent` 构造、`subscribe` 事件名（`turn_start` / `message_update` / `tool_execution_start`）与 0.73 一致，`runner.ts` 逻辑不用改。
- `pi-ai` 的 `streamSimple`、`createAssistantMessageEventStream`、`Model` 在 `/compat` 入口保留，DeepSeek 的 `compat.thinkingFormat: "deepseek"` 仍在（`openai-completions.ts:920`）。
- Node 24 满足 `>=22.19`；底层用内置 `node:sqlite`，不需要 native 编译。

**必须一次性全量升级**：pi-durable 依赖 pi-ai 1.5，若保留 0.73 会出现两份模型类型、两个事件流实现。

## 4. 复用清单（搬什么）

| 能力 | 来源 | 方式 | 规模 |
| --- | --- | --- | --- |
| durable run、恢复、重试、中断语义 | `pi/packages/durable` | npm 依赖 | — |
| 工具任务化（intent 先落盘、`replay: safe`、结果分 output/details） | 同上 | npm 依赖 | — |
| 上下文压缩（阈值、保留窗口、摘要条目、失败重试） | 同上 `harness/compaction.ts` | npm 依赖 | — |
| 会话 watch（视图 + ops，给 UI 的增量流） | 同上 `watch()` | npm 依赖 | — |
| 每会话 agent 配置（model / tools / instructions / maxTurns） | 同上 `configure()` | npm 依赖 | — |
| Agent 循环、队列、`continue()` | `pi/packages/agent` | npm 依赖 | — |
| ask_user 的问题 schema + 跳过引导 | `dsh/packages/interaction/tool-ask-user/src/index.ts`（120 行） | 复制 schema 与提示词 | ~80 行改写成工具 |
| ask_user 超时/自动继续语义 | 同上 `timed.ts`（212 行） | 参考 | 读一遍即可 |
| 工具结果截断与保留策略 | `opencode/packages/core/src/tool-output.ts`（159 行） | 复制改写为通用 truncate | ~120 行 |
| 压缩摘要提示词 | `opencode/.../session/compaction.ts`（1271 行，取提示词段）或 `pi/coding-agent/.../compaction/compaction.ts`（1104 行） | 只抄 prompt 与阈值策略 | ~100 行 |
| 权限/确认分级 | `opencode/packages/core/src/permission/`（160 行） | 参考规则模型 | 自写 60 行 |
| 会话回放/撤销 | `opencode` 的 session revert + 自家版本链 | 参考 | 复用现有版本链 |

**明确不搬的**：

- `openclaw/packages/memory-host-sdk`（19k 行，和它的宿主运行时绑死）。
- `dsh` 的 plugin 体系（cordis 依赖注入），只为几个小工具引入整套插件框架不划算。
- `pi-durable` 自带的 `read/write/edit/bash` 工具（编码向，旅行 Agent 用不上）。

## 5. 升级迁移清单（0.73 → 1.5）

机械改动，半天内可完成，但要全量回归。

- [ ] `package.json`：移除 `@mariozechner/pi-agent-core`、`@mariozechner/pi-ai`，加三个 `@earendil-works/*@1.5.0`。
- [ ] import 路径替换，共 9 个文件：
  - `apps/server/src/generation/agents/runner.ts`
  - `apps/server/src/generation/model.ts`
  - `apps/server/src/generation/tools/defineTool.ts`
  - `apps/server/src/generation/tools/draftTools.ts`、`geoTools.ts`、`researchTools.ts`、`reviewTools.ts`
  - `apps/server/src/__tests__/agentCompletion.test.ts`、`llmRetry.test.ts`
- [ ] `pi-ai` 的 `streamSimple` 等改从 `@earendil-works/pi-ai/compat` 引入（api 类型从主入口拿）。
- [ ] 核对 `model.ts`：`api: 'openai-completions'`、`compat.thinkingFormat`、`maxTokens` 字段仍有效。
- [ ] `npm run typecheck` + `npm run eval:test` + 一次真实生成，确认事件、用量、重试行为不变。

## 6. 必须自写的部分（旅行领域）

### 6.1 DraftTrip（~200 行）

run 开始时把 trip 读成内存工作副本（带 `baseVersion`、`updatedAt`），所有写工具只改它，回合末由钩子提交。这样保住「一版一轮、可撤销、乐观锁」三条不变量。

### 6.2 工具（12 个，~700 行）

| 组 | 工具 | 说明 |
| --- | --- | --- |
| 读 | `get_trip`、`get_day`、`list_versions` | 读 draft，不查库 |
| 查 | `search_places`、`get_place`、`get_weather` | 复用 `placeRetrieval` / `tripWeatherService`，走现有预算 |
| 搜 | `web_search`、`search_food` | 复用 `searchSource` / `foodSearch`，SEARCH 预算 |
| 写 | `add_activity`、`update_activity`、`delete_activity`、`move_activity`、`add_day`、`remove_day`、`set_day_title`、`set_trip_meta` | 只改 draft，返回 diff |
| 交互 | `ask_user_question`、`present_diff` | 见 §7 |
| 记忆 | `remember` | 写 L3，可关 |

工具 schema 用现有 TypeBox 写法即可（pi-schema 也接受标准 JSON Schema，只是类型推断弱一点）。

### 6.3 提交钩子（~150 行）

pi-durable 的 `afterRun` 钩子：把 draft 与 base 做 diff → `commitOperation` 落 Postgres 新版本 → 写 `chat_messages` → 触发前端刷新。失败则保留 draft 并返回 409。

### 6.4 SSE 桥（~200 行）

`root.watch()` 的 value/ops 翻译成现有 `ChatStreamEvent`：entries → 正文与工具卡，`pi.live` → 进行中的工具、流式片段，run 结束 → `done`。断线重连用 `watch(context, transcript.resume)`。

### 6.5 记忆（~200 行）

- L1 会话：用 pi-durable 的 compaction，不自己写。
- L2 行程：`trip_notes` 表 + 注入 prompt。
- L3 用户：`user_memory` 表 + 设置页；写入需确认（敏感类）。

### 6.6 前端（~450 行）

- `ToolTimeline`：复用生成页时间线的视觉（`ChatProgress`）。
- `AskUserCard`：单选/多选/自由输入。
- `DiffCard`：活动级 diff + 撤销（走现有版本恢复）。

## 7. ask_user_question 的落法

**第一版：结束本轮 + 挂起问题**（跟 dsh `timed` 模式一致，零 durability 复杂度）。

1. 工具被调用 → 写 `chat_pending_questions` → 返回「已向用户提问」并 `control.terminate`。
2. run 以 `unanswered` 结束，前端弹窗。
3. 用户回答 → 作为下一条输入提交，带上 `answers`，模型接着聊。

优点：天然可恢复、跨刷新不丢、多端一致。缺点：不是「同一次 run 内继续」，但对用户不可见。

**第二版（可选）**：工具内 `sleepUntil` 轮询答案，实现同 run 阻塞；进程重启后按 `replay: safe` 重跑。等第一版跑稳再看。

## 8. 数据与状态分工

| 状态 | 存放 | 理由 |
| --- | --- | --- |
| agent transcript、run、工具调用、压缩摘要 | pi-durable SQLite（`data/chat-runs.sqlite`） | 单实例部署，文件+WAL 足够；不写 Postgres 适配器 |
| 用户可见的对话消息 | Postgres `chat_messages` | 现有 API/前端契约不变 |
| 行程与版本 | Postgres（沿用） | 已有版本链 |
| 记忆 | Postgres `trip_notes` / `user_memory` | 可查询、可删 |
| 绑定关系 | Postgres `chat_run_bindings` | conversationId ↔ durable conversationId ↔ userId |

注意 pi-durable「一个存储只能被一个进程打开」，与现有单实例部署假设一致；将来多实例要先解决这点。

## 9. 任务清单

### P0 POC（已完成并被替换，2026-11-05）

P0 用假工具（`set_note` / `get_notes`）验证了四条门槛：自定义 baseUrl 模型、多轮工具循环、
`watch()` → SSE、关停后 `resume()` 续跑、`afterRun` 落库。结论成立后，P0 的假工具、演示脚本和
`agent_run_commits` 表已全部删除，只保留运行时与模型层。

### P1 只读 Agent（第一刀已接入，2026-11-05）

已落地：

- [x] `chat/agent/runtime.ts`：每人一份 SQLite，每会话一个 durable conversation，`watch()` → 事件
- [x] `chat/agent/tools.ts`：`get_trip` / `get_day` / `search_places` / `web_search` / `get_weather`（全部走现有预算）
- [x] `chat/agent/turn.ts`：durable 会话绑定（`agent_conversations`）、进度/正文映射、消息落库
- [x] 灰度开关 `AGENT_DETAIL_CHAT=1`；只接管只读问答，修改意图仍走原确定性链路
- [x] 会话内并发保护（2026-11-05）：同一用户同时只允许一个回合，第二个请求 409 `AGENT_BUSY`；
      停止/超时会中断 durable 运行并释放锁（`agentRuntime.test.ts` 覆盖并发、异常、取消三条路径）
- [x] `agentRuntime.test.ts` 三条测试；真实模型 + 真实数据库的冒烟通过

仍待完成：

- [ ] 记忆注入（L2 trip_notes）与 persona 打磨
- [ ] `understandMessage` 降级为 fast-path（现在是「先理解再决定走哪条」）
- [x] 工具结果不截断（2026-11-05）：评估 opencode/pi 的「截断 + 落盘」后改用「不截断 + compaction」——
      我们没有被 Agent 可读的文件工具，截断即丢数据；pi-durable 默认已按阈值压缩上下文
- [x] 10 条 agent 场景进 `eval/`（2026-11-05）：`eval/agent/` 确定性 6 项（分流/工具/不截断/快照/并发/停止，已进 `eval:test`）
      + 真实层 5 项（事实、单日范围、地点、时效、只读边界），入口 `npm run eval:agent[:live]`

### P2 写工具 + 提交（4 天）

- [ ] 8 个写工具 + diff 计算
- [ ] `afterRun` 提交钩子 + 409 冲突处理
- [ ] `present_diff` + 前端 DiffCard + 撤销
- [ ] 验收：版本 +1、原版本可恢复、并发冲突可控

### P3 交互与记忆（4 天）

- [ ] `ask_user_question`（第一版语义）+ 前端弹窗 + 超时
- [ ] L2 trip_notes、L3 user_memory + 设置页
- [ ] compaction 阈值按真实用量调参
- [ ] 验收：问句跨刷新不丢；跨会话记住忌口；可删除

### P4 打磨与评测（2–3 天）

- [ ] 10 条 agent 场景进 `eval/`
- [ ] 逾期/限额/注入攻击用例
- [ ] 成本对比（单轮 vs 多轮），确定默认轮次上限

合计约 3 周。

## 10. 退路：自建精简 runtime

若 POC 失败，只保留 pi-agent-core 1.5，自建约 600 行的最小运行时：

- `chat_runs` + `chat_run_events` 两张表（Postgres，复用现有事务与幂等）
- 每步事件先落库再推 SSE（照抄 pi-durable「先提交再展示」的顺序）
- 恢复：按事件重建 `initialState.messages` + `agent.continue()`
- 压缩：只做「超过阈值就把最早一半换成摘要」，提示词抄 pi/opencode
- 工具循环：直接 `new Agent` + `maxTurns`，不需要任务调度器

这样丢掉的是崩溃级恢复、工具级重试和会话 watch，需要自己补；但依赖少、和现有 Postgres 栈一致。

## 11. 风险

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| pi-durable 是 experimental | API 可能变 | 锁版本；只用 Harness/watch/compact/tools 四个入口；升级按 minor 验证 |
| 新概念（chord 文档、storage） | 学习成本 | POC 只做一条竖切；封装 `chat/agent/runtime.ts` 单点适配 |
| 自定义 baseUrl 模型接入 | 站点/BYOK 双轨可能对不上 | POC 第一项就验证；不通则退回方案 B |
| 双写（SQLite + Postgres） | 不一致 | transcript 只以 durable 为准，Postgres 只存展示副本，提交时一次性写 |
| 成本上升 | 多轮请求 | 轮次上限、只读场景 6 轮、工具结果截断、缓存天气/检索 |
| 前端协议变更 | 回归面大 | 新旧事件并存一个版本；`ChatPanel` 按事件类型分支 |

## 12. 待拍板

1. 是否接受引入 pi-durable（experimental）？——建议接受，POC 把关。
2. ask_user 第一版用「挂起+下一条回答」，还是直接做同 run 阻塞？——建议前者。
3. 跨行程记忆默认开还是关？——建议默认开、可见可删。
4. 写操作确认分级是否照 §7？——建议低风险直接改+可撤销，删除/跨天必确认。