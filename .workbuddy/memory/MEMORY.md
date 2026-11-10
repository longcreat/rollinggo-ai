# RollingGo Trip 项目长期记忆

## 密钥与启动：Doppler 统一管理

- 所有密钥与环境变量由 Doppler 管理（project=`trip`，config=`dev`），本机 CLI 已登录。查：`doppler secrets`；改：`doppler secrets set KEY=VALUE`。
- 启动一律走 Doppler：`npm run dev:doppler`；单跑脚本/测试用 `doppler run -- <cmd>`（如 `doppler run -- node --import tsx <file>`）。
- **本地不使用 `.env`**：`.env` 与 `apps/server/.env` 已删除，不要再生成。`env.ts` 的 `dotenv` 导入在没有 `.env` 时是空操作，真正的值是 `doppler run` 注入的进程环境。
- 少数脚本会显式 `dotenv.config({ path: 'apps/server/.env' })`（如 `verify-trip-weather.mts`）：没有 `.env` 时必须用 `doppler run --` 执行。
- `npm run secrets:sync` 会写出 `.env` 文件，只保留给 compose 的 `env_file` 部署场景；本地不要用它。
- `AGENT_DETAIL_CHAT`（详情页 P1 Agent 开关，只有值 `1` 开启）已在 Doppler dev 设为 1。

## 工程原则：能复用开源实现就直接复用，不造轮子

- 先看现成实现再动手。本项目已在用的 pi 系（`pi-ai` / `pi-agent-core` / `pi-durable` / `pi-schema`）能做的，不自己写循环、压缩、恢复、工具 schema。
- 需要新能力时先读参考源码；能整段搬就整段搬，能薄封装就不重写。自写只保留旅行领域语义（行程怎么改、版本怎么落、卡片怎么渲染）。
- 摘抄/改造开源代码时保留来源注释（仓库 + 路径），必要时注明许可证。参考仓库均为宽松许可：pi / openclaw / opencode / dsh 为 MIT，zcode 为 Apache-2.0。
- 判断标准：运行时与会话状态一律不自研；领域语义必须自写。遵循「复用分三层」原则。

## 参考源码：`/Users/zelon/Desktop/work/harness`

2026-11-05 浅克隆（`--depth 1`），约 1.9GB，`./update.sh` 可更新。详见该目录 `README.md`。

| 目录 | 是什么 | 优先看 |
| --- | --- | --- |
| `pi/` | pi-ai 本体（统一 LLM API + Agent 循环） | `packages/agent`（150 行标准循环）、`packages/ai`、`packages/coding-agent` 的压缩与工具 |
| `opencode/` | 最小可读的终端编码 Agent（Bun） | `packages/core`：工具循环、上下文压缩、LSP/编辑工具；四个成品里最适合先读 |
| `dsh/` | DeepSeek 插件化 harness（Cordis，一切皆插件） | `packages/*/*` 的依赖注入与生命周期、CLI/Web/Desktop 多宿主复用 |
| `zcode/` | Z.ai 的桌面 + Web + CLI 工作台 | `packages/client`、provider 适配、`DESIGN.md` 与依赖约束 |
| `openclaw/` | 常驻网关 + 20 多个聊天渠道 | `packages/agent-core`（pi 循环的生产级演进）、会话隔离与权限 |

阅读顺序：pi → opencode → dsh → zcode → openclaw。

## 已落地 / 可直接搬的对应关系

- 详情页 Agent 运行时：直接用 `@earendil-works/pi-durable`（durable run、崩溃恢复、`watch()`→SSE），只自写旅行工具与提交钩子。
- 工具结果截断、上下文压缩：优先搬 `opencode` / pi `coding-agent` 的实现，不自己设计阈值算法。
- 并发与隔离：单实例用进程内锁（`startDetailTurn`、agent runtime 的 `activeStorages`）；多副本再上分布式锁。
- 插件化边界：参考 `dsh` 的 Cordis 依赖注入，不自己造插件系统。
