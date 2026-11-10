# rollinggo 旅行 · RollingGo Trip

<p>
  <a href="https://sakiiko.com"><img src="https://img.shields.io/badge/%E5%9C%A8%E7%BA%BF%E4%BD%93%E9%AA%8C-sakiiko.com-2f855a" alt="在线体验"></a>
  <a href="https://github.com/longcreat/rollinggo-ai/actions/workflows/ci.yml"><img src="https://github.com/longcreat/rollinggo-ai/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/longcreat/rollinggo-ai/actions/workflows/docker.yml"><img src="https://github.com/longcreat/rollinggo-ai/actions/workflows/docker.yml/badge.svg" alt="Docker"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License"></a>
</p>

> 开源的 **Agent 旅行工作台** —— 一个 harness Agent 全程编排：查真实地点、排出行程、陪你逐句改稿、行前体检兜底风险，全程在对话与地图上完成。

**一个 Agent，四段旅程**：生成时它派子代理查证、逐日把行程「直播」到地图上；编辑时你说的每一句它都能直接落到行程节点（增删改移、加天、改出行方式），改完自动落版本、可一键撤销；出发前它做一次确定性「体检」，把时空硬冲突变成决策卡让你逐项拍板。数字（距离、通勤、时刻）永远由代码计算，模型只负责决策与表达。


## 它能做什么

- 🧭 **一句话生成行程**：调研 Agent 从真实地点库与全网攻略中取材 → 规划 Agent 片区化选点、顺路排序、推演时刻 → 确定性校准层兜底（真实路线、闭馆日、远郊混排修复）。生成过程在编辑器里**直播**：左边 AI 逐条播报，右边行程与地图逐日长出来
- 💬 **对话即编辑**：行程详情里的 Agent 带 19 个工具——查行程/查地点/查天气/审可行性/问你要决策（问题卡）/直接改行程节点；改完一回合落一个新版本，附「本轮改动」清单，**一键撤销**回到上一版
- 🔍 **行前体检**：确定性规则审计（超载/折返/闭馆/远郊混排/缓冲）→ 每条冲突一张决策卡（按建议改 / 自己处理 / 跳过）→ 实时核验预约政策与天气 → 接受建议即确定性重排并落新版本
- 📍 **地点是查出来的**：高德 POI 单源（文本/周边/景区面状子点），坐标、图片、营业信息真实可溯；社区语料 RAG 检索提供玩法、避雷与预约证据（实证/风险/弱口碑分级采信）
- 🌤️ **带上天气**：和风 15 天逐日预报，Agent 与页面同源；同名城市（西安市 vs 西安区）按类型与热度自动消歧
- 🗺️ **地图与导出**：Leaflet + 高德瓦片，按天配色标记与动线折线；导出 AI 分享图（手账/水墨）与 PDF
- 👥 **多用户开箱可用**：开放注册 / GitHub 登录 / 邀请码；生成与对话配额独立计数；站点供 Key 或 BYOK

## 技术亮点

- **Agent harness 全程编排**：详情对话运行在 pi-durable harness 上——每人一份 SQLite durable 会话（崩溃可恢复、上下文自动压缩），只读子代理并行查证、结构化回传，ask_user 在工具内阻塞等真人作答后同回合继续。写操作走「回合内存草稿 → 提交钩子」：一回合一个版本，乐观锁保护，绝不半成品落库
- **模型决策，代码校准**：模型不自己算距离和时刻——顺路排序、时距推演、真实路线、可行性引擎（超载/折返/闭馆/换乘）、远郊修复全部是 Agent 手上的工具或事后校准层；「上午故宫下午八达岭」这类幻觉被结构性排除
- **可复现的评测**：`packages/evals/` 离线快照回归 + live 评估 + 版本比较 + 显式基线接纳；`packages/evals/agent` 覆盖 Agent 工具策略/并发/快照/只读边界；规划质量指标（段距 p50/p90、重复坐标）与线上 `validate_plan` 同源

## 架构

```
React SPA（首页 · 生成直播编辑器 · 对话/体检工作台）
   │ JSON API + SSE · httpOnly Cookie
Fastify 路由层（TypeBox 校验 · 会话守卫 · userId 数据隔离）
   │
Agent 层（pi-agent-core / pi-ai / pi-durable 1.5）
   ├ 生成：调研 Agent → 规划 Agent → 文案 Agent → 确定性校准层
   ├ 详情对话：读写主 Agent（19 工具 + 只读子代理 + ask_user + 回合草稿提交）
   └ 行前体检：规则审计 → 决策卡 → 实时核验 → 确定性重排
   │
数据层：PostgreSQL 16 + pgvector（业务 + 知识库 + 版本链）
        pi-durable SQLite（Agent 会话，每人一份）
外部：LLM 端点（站点/BYOK）· 高德 · LangSearch · 和风天气
```

技术栈：React 19 + Vite + Tailwind 4 / Fastify + TypeBox / PostgreSQL 16 + pgvector + Drizzle / `@earendil-works/pi-*` 1.5 / zustand + TanStack Query / Leaflet。详见 [技术架构](docs/TECHNICAL_ARCHITECTURE.md)。

## 快速开始

```bash
git clone https://github.com/longcreat/rollinggo-ai.git && cd rollinggo-ai
cp .env.example .env               # 至少填 MASTER_KEY 与站点 LLM Key
docker compose up -d
```

浏览器打开你的域名（或 `http://服务器IP`）注册即可。地图、搜索、天气、embedding 都能缺，缺了自动降级、不影响生成。本地开发：

```bash
npm install
npm run dev:doppler                # Doppler 注入密钥；或 cp .env.example apps/server/.env && npm run dev
```

PostgreSQL + pgvector 用 `docker compose up -d db` 起（或指向已有的本机 / Neon / Supabase 实例）。

**配齐数据源、看成本与配额口径**（高德默认只计量不拦截）→ [部署与配置](docs/DEPLOYMENT.md)。

## 文档

- [技术架构](docs/TECHNICAL_ARCHITECTURE.md) — v0.7：Agent harness 中心架构、数据流、配额口径
- [确定性校准层算法](docs/DETERMINISTIC_SCHEDULING.md)（排程引擎历史与现役校准规则）
- [API 响应与请求约定](docs/API_CONTRACT.md) · [高德预算与日志](docs/AMAP_QUOTAS.md)
- [AI 行程分享图](docs/AI_SHARE_IMAGES.md) · [评估运行说明](packages/evals/README.md)

## 路线图

- [x] M1 全栈行程编辑器（认证 / 历史 / 编辑 / 地图）
- [x] M2 智能生成（调研 / 排程 / SSE 进度）
- [x] M3 导出三件套 + 安全走查
- [x] M4 开源发布（Docker / CI / 文档）
- [x] M5 对话改稿 + 历史版本
- [x] M6 知识库混合检索 + 评估框架
- [x] M7 行程天气与专属建议 + 媒体对象化
- [x] **M8 Agent harness 化（2026-11）**：生成切规划 Agent + 校准层；详情对话升级为读写主 Agent（pi-durable / 子代理 / ask_user / 写工具 / rewind）；行前体检上线；数据源与图片收敛高德单源
- [ ] M9 候选：出行中伴游（Active 阶段）、跨行程记忆（trip_notes / user_memory）、对话加天迁移规划引擎

## License

[MIT](LICENSE)
