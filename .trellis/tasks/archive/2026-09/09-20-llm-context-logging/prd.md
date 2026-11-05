# LLM 请求上下文快照记录模块

## 背景

09-20 调试 plan 阶段「模型不调 set_trip_skeleton」时，只能看到「草稿不完整」的最终报错，
看不到发给模型的实际上下文（system prompt + 消息历史 + 工具定义），被迫手写 curl 复现脚本逐变量对照才定位到
「网关对长 prompt + tools 组合返回空内容」。需要把每次 LLM 请求的完整上下文自动落库，让这类问题可直接查表定位。

## 目标

生成流水线（调研/编排/审校三阶段 Agent）的**每一次 LLM API 请求**，落一条完整快照到 PostgreSQL：

- 请求侧全量：system prompt、消息历史、工具定义、模型 ID
- 响应侧摘要：stopReason、usage、errorMessage、文本内容
- 关联元数据：jobId、userId、phase、round、阶段内第几轮请求（turn）

## 方案

- **拦截点**：pi-agent-core `Agent` 支持自定义 `streamFn`（默认 `pi-ai` 的 `streamSimple`）。
  在 `agents/runner.ts` 包装 streamFn：调用前先异步落库快照，再委托默认 streamSimple；`message_end` 时回写响应摘要。
  （备选 `onPayload` 钩子给的是原始 wire payload，normalized context 更干净，选 streamFn。）
- **新表** `llm_request_logs`：schema.ts + migrate.ts 双更新（幂等 CREATE TABLE IF NOT EXISTS）。
- **降级原则**：记录失败只 console.warn，永不阻断生成（对齐 error-handling spec）。
- **安全**：payload 不含 API key（key 走 getApiKey 独立通道，不进 context）；内容为站点自有数据。

## 表结构

| 列 | 类型 | 说明 |
|---|---|---|
| id | text pk | uid() |
| job_id | text | 生成任务号（内存 Job，非外键） |
| user_id | text | 归属用户 |
| phase | text | research / plan / review |
| round | int | 编排-审校轮次（调研恒 1） |
| turn | int | 阶段内第几次请求（从 1 开始） |
| model | text | 模型 ID |
| system_prompt | text | 完整 system prompt |
| messages | jsonb | 完整消息历史快照 |
| tools | jsonb | 完整工具定义快照 |
| response | jsonb nullable | { stopReason, usage, errorMessage, text } |
| created_at | timestamptz | 请求发起时间 |

索引：`(job_id)`、`(user_id, created_at DESC)`。

## 非目标（后续任务）

- 查询接口 / 前端展示
- embedding、标题生成等非流水线 LLM 调用
- 数据保留策略 / 清理任务
- 开关配置（当前恒开启）

## 验收

1. `npm run typecheck` 通过
2. 跑一次生成（test-beijing-rag.mts），`llm_request_logs` 出现 research/plan 阶段的逐 turn 行，
   messages 内容随 turn 递增（含工具结果回填）
3. 记录路径人为断库时不影响生成主流程

## 范围扩展（09-20 追加）：生成时间线实时展示

决策：摘要+可展开全文｜SSE 实时推送｜开发者调试视图。

- shared：`GenerationEvent` 新增 `llm_request`（完整上下文）与 `llm_response`（stopReason/token）两个事件，
  按 phase 内 turn 配对；刷新重放可还原（事件走 jobManager 缓冲区）。
- server：`PhaseEventSink` 增加 `onLlmRequest/onLlmResponse`；runner 在 recorder 或 onLlmRequest 任一存在时
  才包装 streamFn；orchestrator 的 sinkFor 转发为 SSE 事件。
- web：`generationTimeline.ts` 重建 `LlmRequestItem`；`GenerationTimeline.tsx` 以 details/summary 渲染
  「LLM 请求 #N · 消息数 · 工具数 · system 字数 · stopReason · ↑入/↓出」，展开看全文。

4. 生成页面时间线实时长出 LLM 请求节点，展开可见完整 prompt/消息/工具，刷新后重放仍在
