# PRD：按实测结论依次修四项耗时瓶颈

- 任务：`09-20-gen-timing-soft-reasoning-effort`
- 创建：2026-09-20 / aimer
- 优先级：P2
- 前置：`09-20-gen-timing`（实测报告 `.trellis/tasks/09-20-gen-timing/research/2026-09-20-phase-timing.md`）

## 背景

实测两次真实生成：总墙钟 585.1s / 793.4s，编排（plan）阶段占 68~75%。定位到四个独立瓶颈，本任务按报告的建议顺序依次实现。

## 目标（依次执行，In Scope）

### 1. 地理编码快速失败 + 熔断（省 ~150s）

`apps/server/src/integrations/geocode.ts`：

- Nominatim 单次超时 `10s → 2.5s`（常量 `NOMINATIM_TIMEOUT_MS`，附原因注释）
- 新增模块级熔断（照 `createRouteBreaker` 的精神，但**进程级**而非任务级——Nominatim 是全局外部服务，不可达与单个任务无关）：
  - 连续失败（超时/网络错/HTTP 非 2xx）达 3 次 → 打开
  - 打开期间直接返回 `null`，不发请求
  - 60s 冷却后放行一次探测；探测成功即关闭并清零
  - 「HTTP 200 + 空结果」算成功（证明服务可达），清零计数
  - 打开时 `console.warn` 一行，说明后续地点全部降级

### 2. 修高德日额度（消掉瓶颈本身）

- `apps/server/.env` 与 `.env.example`：`AMAP_DAILY_BUDGET=150 → 600`
- 依据：`geoPipeline.init()` 要求剩余 ≥ `GEOCODE_MAX_PER_TASK(40) + ROUTE_MAX_PER_TASK(20) = 60`；单次 3 天行程实测约 68 次高德调用（research 8 次 POI 搜索 + geocode/route），150 只够 2 次生成，实测已被闸门关停
- `.env.example` 注释补充「闸门门槛 60」的说明

### 3. soft 违规最多修一次（省 ~70~90s）

实测：第 1 天缓冲 9% < `softBufferRatio` 10% 是 **soft（不阻断）**，模型却在 plan turn5~13 空转 9 轮、77.7s。三处收敛：

- `apps/server/src/generation/tools/draftTools.ts` 的 `check_feasibility`：`hard === 0` 时在返回正文追加一句「以上均为不阻断提交的可优化提示：最多再调整一次，随后立即 submit_plan，不要反复微调同一项」
- `apps/server/src/generation/prompts.ts` 的 `PLANNER_SYSTEM_PROMPT` 第 5 步：明确 soft 项「最多调整一次」
- 不改 `packages/shared/src/feasibility.ts` 的 `describeFeasibility`（审校阶段共用，blast radius 更大且非本次目标）

### 4. reasoning effort = medium（省 ~200s+）

实测 plan 阶段可见文本仅 392 字符却烧了 47228 输出 token，两轮 hidden `thinking` 合计 90380 字符。当前配置实际上把推理**关着**：

- `apps/server/src/generation/agents/runner.ts`：`thinkingLevel: 'off'` → `'medium'`
- `apps/server/src/generation/model.ts`：`reasoning: false` → `true`
- 两处都是必需的：pi-ai 的 `clampThinkingLevel(model, level)` 在 `model.reasoning === false` 时只返回 `['off']`，任何 thinkingLevel 都会被夹回 off；反之 `model.reasoning === true` 且 compat 为默认 `openai` 时，`reasoning_effort` 才会写进请求体
- 用真实请求验证 payload 里出现 `reasoning_effort: "medium"`，且不再出现 6 万字符级 thinking

## 非目标（Out of Scope）

- 不改 `llm_request_logs`、不动 `maxTokens`（32k 不是约束）
- 不做 research 阶段 `add_candidate` 批量提交（收益 ~30s，另议）
- 不改金集 / eval 快照
- 不换模型或网关

## 验收标准

- [ ] `npx tsx test-geo-latency.mts`（在 apps/server 下）：闸门判定为「高德可用」，且 Nominatim 不可达时单个地点耗时从 ~22s 降到 ~5s 以内（2 次快速失败）
- [ ] `npm run typecheck` 通过
- [ ] `MASTER_KEY=... node --import tsx --test apps/server/src/__tests__/*.test.ts` 全绿
- [ ] 真实请求 payload 含 `reasoning_effort: "medium"`（`test-reasoning-effort.mts` 打印）
- [ ] 复跑 `npx tsx test-gen-timing.mts`：总墙钟与 plan 阶段 LLM 等待明显下降，plan 输出 token 明显低于 47228

## 风险

| 风险 | 缓解 |
| --- | --- |
| upstream（deepseek 系）要求 assistant 消息带 reasoning_content，开启 reasoning 后 pi-ai 的消息转换可能不符合要求 → 400 | 先用一次极小的真实请求验证（`test-reasoning-effort.mts`），不通过就回退 `reasoning: false` 并把结论写进 spec |
| 熔断太激进，网络抖动时整进程失去 Nominatim | 阈值 3 + 60s 冷却半开探测；且 Nominatim 只是高德之后的兜底 |
| 额度提高后真实烧掉高德配额 | 600 仍远低于高德 Web 服务免费额度；数值是配置项，可随时回退 |
| thinking 变短反而降低规划质量 | 复跑后同时看候选数、可行性硬性问题与行程完整性，不只看耗时 |

## 工作量

约 45 分钟（4 处代码改动 + 1 个验证脚本 + 一轮复跑验证）。
