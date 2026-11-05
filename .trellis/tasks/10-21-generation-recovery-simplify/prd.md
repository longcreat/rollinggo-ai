# 生成任务恢复路径合并（去掉 sessionStorage 双轨）

## Goal

生成任务的「刷新 / 关窗后再回来」恢复目前有两条并行路径：

1. **前端 sessionStorage**：`tw.activeJobId` 记住 jobId → 挂载时查快照 → 三分支（running 重连 / done 跳转 / 其他清掉）
2. **服务端 current**：`GET /api/generations/current` 查该用户正在跑的任务 → 自动认领

两条路径在 `running` 状态上功能完全重叠。目标是把恢复语义收敛到服务端一条路径，删掉前端的本地状态机，减少一处状态同步成本和一整类"本地存储残留"问题。

## 现状证据

| 事实 | 位置 |
|---|---|
| 前端从 sessionStorage 读 jobId 再查快照 | `apps/web/src/hooks/useGenerationRun.ts:83` |
| `ACTIVE_JOB_KEY = 'tw.activeJobId'` | `apps/web/src/hooks/useGenerationRun.ts:11` |
| 该 key 在 useGenerationRun 内共 13 处读写 | `useGenerationRun.ts:58,71,83,93,97,102,140,157,173,185,205,229,259,272` |
| 全局 orphan 任务查询（全站唯一调用点） | `apps/web/src/components/GenerationProvider.tsx:45` |
| `current` 只查 running | `apps/server/src/routes/generations.ts:91-95` → `getRunningJobId()` |
| 任务进终态即从 runningByUser 删除 | `apps/server/src/generation/jobManager.ts:99` |
| job 对象保留 30 分钟供刷新恢复 | `jobManager.ts:14` `FINISHED_TTL_MS = 30 * 60 * 1000` |
| 快照接口能查终态任务 | `apps/server/src/routes/generations.ts` `GET /:jobId` → `getJob()` |
| 对话自动触发生成也写这个 key | `apps/web/src/components/chat/ChatPanel.tsx:57` |
| 登出 / 应用初始化时清理 | `apps/web/src/components/AppLayout.tsx:63`、`apps/web/src/App.tsx:20` |
| 浏览器测试断言了 sessionStorage | `apps/web/tests/generation-recovery-browser.mjs:82,108`、`login-dialog-browser.mjs:69` |

## 两条路径的实际差异（已验证）

| 场景 | sessionStorage 路径 | 仅 current 路径 |
|---|---|---|
| running 时刷新 | 恢复并全量重放 | 恢复并全量重放（重叠） |
| **刚 done 就刷新** | 快照 `status==='done'` → 直接跳到新行程 | `current` 返回 `null`（终态已从 runningByUser 删除）→ 回首页，用户要自己去列表找 |
| **任务过期 / 服务重启** | 快照 404 → 明确提示「任务已丢失，本次不计入配额」 | 静默 `null`，无任何提示 |
| 关浏览器再打开 | 失效（sessionStorage 按标签页隔离且关闭即清空） | 恢复 |
| 多标签页 | 各 tab 独立 | tab B 也会认领 tab A 的任务（期望行为） |
| 首屏建立 SSE | 同步读，立刻建连 | 多一次 RTT |

**结论**：`running` 场景确实冗余，但 sessionStorage 目前独占「done 跳转」和「404 明确提示」两个能力。简化必须先把这两项搬到服务端，否则是功能退化。

## Requirements

### R1 服务端 current 返回最近一条任务（含终态）

`GET /api/generations/current` 改为返回该用户 **30 分钟内最近创建的一条任务**（任意状态），而不是只返回 running。

- 实现上需要按 `userId` 过滤 `jobs` Map 取 `createdAt` 最大者（jobs 数量受 30 分钟 TTL 约束，量级可接受）
- 返回结构继续用 `jobView()`，不加新字段
- 语义变更需在路由注释里写明：调用方要自己按 status 分流

### R2 全局 Provider 只认领 running（行为不变）

`GenerationProvider` 的 adopt effect 保持只处理 `status === 'running'`，避免影响其他页面。

### R3 终态任务只在生成页消费

「刚 done 就刷新」的场景，用户刷新的一定是生成页 `/trips/new`。因此终态跳转只在 `NewTripPage` 挂载时处理，不进全局 Provider。

### R4 删除 sessionStorage 双轨

- 删掉 `ACTIVE_JOB_KEY` 及其 13 处读写
- `restoring` 状态改由 `useCurrentGeneration` 的 `isLoading` 承担（`NewTripPage.tsx:151` 已有 `restoring || discovering` 的分支可复用）
- `ChatPanel.tsx:57` 的 `autoStartedJobId` 传递改为不落本地存储（挂载后由 current 发现，或用 URL query 显式传参）
- `App.tsx:20`、`AppLayout.tsx:63` 的清理逻辑一并删除

## 必须先定的设计决策（阻断项）

如果让全局 Provider 也消费终态任务，会产生新问题：**用户在 30 分钟内每次进站都会被自动跳到那个已完成的行程**。三个选项：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（推荐）** | 终态只在生成页消费（R3） | 生成页以外的入口不会自动恢复 done，但那些入口本来也没有恢复语义 |
| B | 服务端加 `acknowledged` 标记 + `POST /:jobId/ack` | 多一个接口，需要处理 ack 失败 |
| C | 前端记 `lastSeenJobId` | 等于绕回本地存储，简化目标落空 |

未定此决策前不要动手。

## 改动清单与工作量

| 文件 | 改什么 | 规模 |
|---|---|---|
| `apps/server/src/generation/jobManager.ts` | 新增 `getLatestJobForUser(userId)` | +10 行 |
| `apps/server/src/routes/generations.ts` | `/current` 改用新函数 + 注释 | ~5 行 |
| `apps/web/src/hooks/useGenerationRun.ts` | 删 restoring effect、13 处 sessionStorage、`restoring` 字段 | −80 / +20 行 |
| `apps/web/src/components/GenerationProvider.tsx` | adopt effect 去掉 `run.restoring` 依赖 | ~5 行 |
| `apps/web/src/pages/NewTripPage.tsx` | 补终态消费分支，复用 discovering | ~15 行 |
| `apps/web/src/components/chat/ChatPanel.tsx` | `autoStartedJobId` 传递方式 | ~5 行 |
| `apps/web/src/App.tsx` / `AppLayout.tsx` | 删两处清理 | −4 行 |
| `apps/web/tests/generation-recovery-browser.mjs` | 断言从 sessionStorage 改为 current 驱动 | 重写约半个文件 |
| `apps/server/src/__tests__` | 新增 current 返回终态的用例 | +1 文件 |

**总量约 200 行，涉及 4 个核心文件 + 2 个浏览器测试。** 属于中等规模重构，不是小改。

## 风险

1. **核心链路**。生成全程都依赖这套状态机，改坏的影响面是「用户点了生成什么都没有」或「跳到错误的行程」。必须有真实生成验证，只跑单测不够。
2. **验证成本高**。需要真实 LLM 生成（耗时 + 消耗每日配额），且浏览器测试要起 Vite + Playwright。
3. **当前工作区不干净**。有 14 个未提交改动（`auth.ts` / `EmailCodeField.tsx` / `RegisterPage.tsx` / `generationCards.ts` 等），不在干净基线上做中等重构风险叠加。
4. **测试重写**。`generation-recovery-browser.mjs` 目前整个用例设计是围绕 sessionStorage 恢复写的，改完全部断言逻辑都要调整，容易出现「测试改绿但行为错了」。

## 结论与排期建议

方案可行、收益明确（少一套状态机 + 少一类本地存储残留问题），但**不适合在 2026-10-23 面试前动核心链路**。建议在面试结束后、且当前 14 个改动提交完成后的干净基线上单独开工。

## Acceptance Criteria

- [ ] `GET /api/generations/current` 在任务完成后 30 分钟内仍能返回该任务（含 `status` 与 `tripId`）
- [ ] 生成中刷新页面 → 恢复进度视图，事件从 0 全量重放，无重复渲染
- [ ] 生成完成瞬间刷新 → 直接跳到新生成的行程
- [ ] 关浏览器再打开 → 进入页面后能认领仍在跑的任务
- [ ] 任务过期 / 服务重启后刷新 → 给出「任务已丢失，不计入配额」的明确提示（不能静默回首页）
- [ ] 全仓无 `tw.activeJobId` / `ACTIVE_JOB_KEY` 残留
- [ ] `apps/web/tests/generation-recovery-browser.mjs` 通过，且断言不再依赖 sessionStorage
- [ ] 真实跑一次完整生成，确认开始→进度→完成→跳转链路无回归
