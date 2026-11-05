# 真实 frozen smoke 故障排查与修复（2026-10-04）

状态：代码与自测可交付，等待用户验收；未提交、未归档、未修改原运行结果。

## 原运行与原因

运行：`eval/runs/2026-10-04T12-35-42-434Z-c8163edf`。配置记录：grok-4.7，经站点模型网关；frozen 输入 4,841 地点。和风天气提示源于评估关闭天气，不是故障原因。

- 上海：调研正常查到知识库地点，补查了两个地点/网页。第 3 次模型响应 stopReason=stop，正文是含 12 个候选的 JSON 代码块，没有调用 submit_research。工具没有接到提交，因此没有候选事件；最终 3 天都是自由安排与午晚餐占位。评估 ERROR 合理，生成阶段却没有验证提交成功。
- 北京：调研最终有候选，阶段耗时 508,497ms；计划阶段 4,903ms，文案未完成，任务在约 600 秒取消，符合整例 600000ms 超时。已有记录不足以精确拆出每次 504 尝试耗时，不能把所有等待都归因于一个请求。
- 重庆：最终报告为模型调用异常 HTTP 504，并混入 HTML 错误页。属于模型请求链路中的网关/上游故障；单凭本地响应不能确定网关内部哪一级失效。
- 原进程已自行结束，live 锁已释放。没有终止用户进程或清理不属于测试的旧数据库。

上海请求证据在评估数据库尚存在时只读提取，仅保留阶段、轮次、停止原因、工具名称和正文格式/候选数量统计：`live-failure-diagnostic.json`。没有保留完整提示词、工具参数、原始网页或模型正文。

## 修复

- `runPhaseAgent` 增加可选 completion 条件。同一 Agent 停机却未提交时最多提醒一次；保留上下文、已入池数据、累计 token 与总轮次限制。
- 调研使用成功 submit_research 设置的 summary 与非空 pool 判断完成。正文 JSON 不自动入池；持续未提交返回明确错误，orchestrator 在排程/保存前停止。
- 取消、上游错误与轮次耗尽不追加纠正请求；普通正文阶段保持原行为。
- HTML 网关错误转成含 HTTP 状态的简短说明，保留原有上游重试策略。
- live 事件保留工具名称/错误标志/耗时及 LLM phase/turn/stopReason/HTTP 状态；不保存对应原始参数与错误正文。失败/取消也记录总耗时，单例计时器设置 timeout 原因。
- CI 增加提交纠正与持续未提交的 mock 验证。

## 自测

- `agentCompletion.test.ts` + `llmRetry.test.ts`：14/14 通过；覆盖文本纠正、重复文本拒绝、上下文/用量、正常提交、普通文本阶段、错误、取消、轮次上限、HTML 状态及原重试语义。
- `npm run eval:test`：29/29 通过。
- `npm run typecheck`：通过。
- `scripts/verify-generation-flow.mts`：独立数据库 + mock；初始化失败、事务回滚、正常保存、修订版本链、取消边界和 SSE 通过。
- `npm run eval`：9/9 PASS，hard=0、soft=54；报告 `eval/runs/2026-10-04T13-02-58-118Z-b97a9c89/report.md`。沙箱内初跑遇 Windows EPERM，使用已授权沙箱外命令重跑通过。
- 正常工具提交：`eval/runs/verify-live-1791119166401/2026-10-04T13-06-07-412Z-eb308ae8/report.md`。
- 正文纠正成功：`eval/runs/verify-live-1791119029790/2026-10-04T13-03-51-634Z-f7283e00/report.md`。
- 持续不提交：`eval/runs/verify-live-1791119118094/2026-10-04T13-05-19-175Z-08fb6a5c/report.md`。预期 ERROR，验证脚本 PASS；没有进入 plan，没有保存占位行程，恰好两次调研请求。
- 三种 live mock 均验证事件采集、独立数据库和锁清理。CI YAML 解析、定向 diff 检查通过；历史 snapshots 未修改。

## 下一次真实验证

本轮没有新发真实模型/地图调用；网关故障尚未由真实重跑证明恢复。先单例复测，继续 504 时检查当前网关/模型可用性后再跑 smoke：

```powershell
npm run eval:live -- --knowledge frozen --knowledge-snapshot eval/knowledge-snapshots/kb-2026-10-04 --case shanghai-3d-transit
```
