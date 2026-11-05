# 行程生成主流程验收

验收日期：2026-09-29。原审查九项已修复；完整页面验收发现的两项恢复/返回问题也已修复。使用真实本地 PostgreSQL、生产构建页面、mock LLM 和原生 EventSource；未调用真实 LLM。

## 逐项结果

| 问题 | 修复边界 | 验收证据 |
| --- | --- | --- |
| 初始化异常导致任务一直 running | 全部异步初始化纳入 try，失败/取消先终态后审计 | `verify-generation-flow.mts` 初始化与审计同时失败仍解锁、初始化取消 |
| 行程保存与成功记账不原子 | 同一事务 writer 保存行程与 done 审计；COMMIT 为成功边界 | SQL trigger 拒绝审计后零行程；表锁等待期间取消回滚；真实提交后迟到取消仍 done；修订版本链正确 |
| tight + 美食超过 8 活动 | 切段前预留两餐容量 | 三节奏 × 候选 0/1/8/20 × 闭馆/开放组合；真实 DraftTrip 校验；8 个街区输入最终 8 活动 |
| 自由安排日缺餐 | 空天/整段闭馆也插午晚餐 | 排程组合回归、候选不足的真实生成与浏览器落库结果 |
| 链起点与段内重排丢失先后约束 | 多前置拓扑约束用于起点与每段重排 | 高分后置点、多前置、故宫/景山旧测试、循环约束有限降级 |
| 贪心日期占位误丢段 | 最多 15 天全局 bitmask DP | 灵活段让出唯一开放日、连锁换日、15 天、原八达岭闭馆回归 |
| 未知评分被当成 0 | optional 指标贯穿加载/合并，已知值才聚合 | 缺失/真实零单测；真实 SQL 加载金集地点评分为 65 |
| SSE 重连清空历史 | 保留历史，按当前任务事件 ID 去重 | 原生重连携带 Last-Event-ID=3，重复 3 + 新 4 后仍完整保留 1–4；新任务/刷新游标重建 |
| SSE 终态重放未初始化退订 | 预置退订句柄，同步 replay 后收尾，终态不挂 live listener | HTTP 全量终态/终态游标读取到 EOF；客户端断连后 listener 为 0；无路由异常 |
| 取消后返回停在启动页 | reset 同时导航到唯一收集入口首页 | 取消失败重试成功后返回首页，随后新任务正常完成 |
| 完成快照被首页守卫截走 | 完成结果优先导航；恢复/已有任务不触发 autostart | 已完成快照打开原行程，生成 POST 数不增加 |

## 最终验证

- `npm run typecheck`：通过（shared/server/web/eval）。
- `npm run build -w apps/web`：通过；保留现有大 chunk 提示。
- 服务端全套：**388/388** 通过，0 失败/跳过。
- `node scripts/verify-c2.mjs`：全部通过（生成 API、SSE、取消、配额、BYOK、审计）。
- `node --import tsx scripts/verify-generation-flow.mts`：10 组数据库/编排/SSE 场景通过。
- `node apps/web/tests/generation-recovery-browser.mjs`：3 组原生 SSE/React hook 场景通过。
- `node scripts/verify-generation-browser.mjs`：5 组生产页面场景通过。
- `git diff --check`：通过。

全套服务端测试使用专用空库，串行运行以避免启动 migration 争用：

```powershell
$env:MASTER_KEY='a' * 64
$env:DATABASE_URL='postgres://postgres@127.0.0.1:18797/generation_flow_unit_20260929'
$env:DOTENV_CONFIG_PATH='./data/generation-flow-absent.env'
node --import tsx --test --test-concurrency=1 apps/server/src/__tests__/*.test.ts
```

两个新的数据库验收脚本自行创建和删除随机命名库；可用 `VERIFY_GENERATION_ADMIN_URL` 指定测试 PostgreSQL（默认本机 18797）。浏览器完整流程先构建 web；hook 回归先在 18811 启动 Vite。Chrome 默认使用 Windows 本机安装，可用 `CHROME_PATH` 指定。服务器预加载 `scripts/lib/local-fetch-only.mjs`，阻止地图/封面的公共 fetch 兜底影响结果。

## 续审复核（2026-09-29）

- 恢复任务后核对暂存实现、回归测试及跨层契约，未发现新的阻断性代码问题。
- 本次重新通过全仓 typecheck、web build、服务端 388/388 单测、10 组数据库故障场景、3 组原生 SSE 恢复场景和 5 组生产页面场景；`verify-c2.mjs` 沿用前轮验收记录，未重复执行。
- 初次复跑因本地 PostgreSQL 未启动、旧测试库已清理而失败；启动原隔离实例并新建 `generation_flow_unit_review_20260929` 后，全套单测通过（0 失败、取消、跳过）。
- 修正 `generation-guidelines.md` 闭馆场景中残留的贪心算法示例与错误矩阵，统一为全局日期匹配及其冲突优先级。

## 范围与限制

- 旧 `verify-c3.mjs` 依赖已删除的城市卡片、独立表单和旧时间线选择器，未作为通过证据；当前主流程由新生产浏览器脚本覆盖。旧 C3 中与本任务无关的历史编辑器/移动端断言未宣称已验收。
- PostgreSQL 测试实例没有 pgvector，按现有逻辑降级；未验收线上模型质量、真实地图接口或 pgvector 检索效果。
- 保留单进程任务模型和 512 条缓冲边界；服务重启丢任务、缓冲外历史不可恢复均未改为持久化队列。
- 日期匹配针对已选定的整段寻找全局解，不重新分段；不可满足时按既有规则如实降级。缺坐标、缺端点和循环先后约束保留确定性降级。
- AbortSignal 在异步操作边界检查；正在等待的数据库操作需返回后完成回滚，不承诺即时中断 PostgreSQL 查询。

## 复盘与预防

根因主要是跨层契约错配和组合测试缺口：活动上限未计入餐次；客户端假设全量重放但服务端补增量；成功行程与配额记账使用不同提交边界。

日期匹配初版优先保留整段，导致旧八达岭场景安排更多闭馆活动。保留该旧回归，将目标明确为先减少实际安排的闭馆活动，再减少整段丢弃。浏览器测试初版夹具遇到 React context 实例不一致、Vite refresh preamble 和 Chrome loopback 限制；改为同一 Vite 模块图中的 TSX 夹具并为本机测试显式配置浏览器。生产页面验收独立走真实页面与 API，避免只证明夹具可运行。

已更新 generation/database/quality/hook 规范，记录事务取消边界、未知评分、容量预留、全局日期匹配、同步重放资源释放和恢复页面守卫，并将新脚本加入质量指南。本仓库没有 `src/templates/markdown/spec`，无模板同步项。
