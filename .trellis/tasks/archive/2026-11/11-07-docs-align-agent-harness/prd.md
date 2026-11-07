# PRD:产品文档清理,对齐 Agent harness 现实

## 背景与产品目标(用户 2026-11-07 定调)

1. 产品目标:**完全通过 agent harness 实现任何结果**。抛弃传统设计路径;配额不限制(测试环境);Agent 无开关;就一个 harness 主 Agent 自主编排(子代理/工具/写链路已就绪)。harness 实现逻辑以 `~/Desktop/work/harness`(pi / openclaw / zcode / opencode / dsh)开源项目为准,不自行发明。
2. 现状:代码已发生四个范式反转(生成=LLM 规划 Agent+校准层;dayPlanner 产出时刻表;配额只计量不拦截;撤销=rewind 删版本),但 README/架构文档/代码头注释仍宣传旧叙事,严重误导。

## 范围(清理成最新事实)

| 文件 | 问题 | 处理 |
|---|---|---|
| `README.md` | 技术亮点第一条「结构由代码算」已反转;架构图/路线图过时 | 重写亮点/架构/定位,以「单一 harness Agent」为叙事中心 |
| `docs/TECHNICAL_ARCHITECTURE.md` | v0.6 大半篇幅描述已被替换的确定性排程/配额三道闸/图库四层 | 出 v0.7:当前事实架构(生成三阶段+校准层、详情 harness、体检、围栏、图片单源、配额只计量),旧方案段落压缩为修订记录式历史注记 |
| `apps/server/src/generation/orchestrator.ts:1-20` | 头注释仍称「阶段2=零LLM 纯算法(最值钱的设计)」 | 改为当前事实(规划 Agent+确定性校准层) |
| `docs/DETERMINISTIC_SCHEDULING.md` | buildSchedule 仅剩「聊天加天」在用,主链已弃用 | 顶部加现状注记(转型为校准层;排程由规划 Agent 承担) |
| `docs/PRD.md` | §5 非功能表残留 SQLite;F1-F8 与现状偏差 | 顶部现状注记 + 修明显硬伤,不全文重写 |
| `docs/DEPLOYMENT.md` | 配额闸门相关表述(如与 enforce=false 冲突) | 按当前口径校正 |
| `apps/server/src/routes/conversations.ts:12` | 指向已删除 understanding 链路的过期注释 | 删/改 |
| 不动 | AMAP_QUOTAS.md、PERSON_AGENT_PLAN.md、.env.example(用户已更新);spec 下用户 WIP 修改的文件 | — |

## 不做

- 不删传统代码路径(researchAddedDays/schedule.ts 等迁移是后续任务);本次只让文档说真话
- 不动用户 WIP 中的代码逻辑;不提交(由用户决定,或与 WIP 一起走提交计划)

## 验收

1. grep 全仓文档不再出现「结构由代码算,文案才走模型」作为现行叙事(仅允许存在于历史注记);
2. README/TECHNICAL_ARCHITECTURE 的架构图与 2026-11-07 代码事实一致(三阶段生成、harness 详情、体检、直播编辑器);
3. `npm run typecheck` 通过(orchestrator 注释改动);文档内描述的环境变量与 .env.example 一致。
