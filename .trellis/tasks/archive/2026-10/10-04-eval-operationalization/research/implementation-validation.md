# 第一批交付验证（2026-10-04）

状态：实现及 AI 自测完成，等待用户验收。未提交、未归档、未标记任务完成。

## 已实现

- PostgreSQL live 使用显式本机管理库创建随机评估库，导入前覆盖应用连接并阻止隐式 dotenv 重载；连接清理限定本次拥有的库。
- 固定 87 个历史地点种子，保留原始坐标系并转换为 GCJ-02，golden/empty 明确区分。
- 每次运行独立保存输入、manifest、逐例状态、事件摘要、JSON/Markdown 报告，历史快照不变。
- live 采集完整性检查、失败继续、损坏输入保留和明确退出码。
- 报告差异比较与显式基线接纳，拒绝失败、篡改、重复名称和不兼容数据。
- CI 独立 eval job；真实服务仅提供 workflow_dispatch，未触发远端执行。
- 使用说明与 executable spec 已更新。

## 验证结果

- `npm run eval:test`：24/24 通过（包括原检查器 9 项）。
- `npm run typecheck`：shared/server/web/eval 全部通过。
- `npm run eval`：9/9 PASS，hard=0、soft=54；smoke 3/3 PASS。
- `npm run eval:verify`：真本机 PostgreSQL + mock LLM + 固定地理响应通过；采集 4 个候选、三阶段耗时及用量；连接审计仅见 postgres 与本次评估库，结束后评估库及锁已清理，无测试凭据泄露。
- 初次 mock 未提供地理响应时，坐标覆盖率 67% 被正确判 FAIL；补充测试专用地理响应后通过，没有降低产品 gate。
- 两次独立离线运行通过 `--baseline` 与 `eval:diff` 对比，9 例 UNCHANGED；缺失 timing 的差值保持 unavailable。
- 两个 workflow YAML 解析通过。未运行远端 GitHub Actions。
- `git diff --check` 通过，`eval/snapshots` 没有修改。

## 可查看产物

- 全量报告：`eval/runs/2026-10-04T11-35-32-643Z-11d4109f/report.md`
- 对比报告：`eval/runs/2026-10-04T11-35-32-643Z-11d4109f/comparison.md`
- 最后一次 live mock：`eval/runs/verify-live-1791113944108/2026-10-04T11-39-05-563Z-eb67dc60/report.md`
- 使用说明：`eval/README.md`

本轮没有调用真实模型/地图接口，没有接纳实际基线。测试中的基线接纳仅在临时目录验证。第二批场景语义评估与自动定时运行仍在本批范围之外。
