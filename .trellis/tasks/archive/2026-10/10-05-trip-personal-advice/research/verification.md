# 验证记录

## 默认完整展示（最新确认）
- 按用户明确方案移除展开/收起按钮、条目折叠与正文行数截断，两栏直接完整展示。
- typecheck、build、diff check 及桌面/手机浏览器回归通过；断言全部4条直接可见、无展开/收起按钮、无截断样式。
- 最新截图位于 `full-content-browser/`。未提交、未归档，等待验收。

## 内容精简补充验证
- 新生成约束调整为每栏1–2条、标题≤12字、正文≤60字；历史快照契约维持兼容。
- 基础提醒缩短；默认每栏3条、每条最多3行，展开后保留全部内容；强天气提醒置顶。
- 本轮相关单测6/6、全项目 typecheck、构建、桌面/手机浏览器回归与 diff check 通过。
- 浏览器新增验证默认3条 → 展开4条 → 收起3条，截图位于 `concise-browser/`，手机截图已视觉检查。
- 本轮未调用真实模型，未重跑数据库整链（未改编排与落库）；待用户重新验收，未提交或归档。

实现与自测已具备交付条件，等待用户验收；未提交、未归档，task 保持 in_progress。

## 通过的检查
- `npm run typecheck`：shared / server / web / eval 全部通过。
- `npm run build`：成功。保留现有大 bundle 提示，无构建错误。
- `node --import tsx --test apps/server/src/__tests__/tripAdvice.test.ts apps/server/src/__tests__/agentCompletion.test.ts apps/server/src/__tests__/titleFont.test.ts apps/web/tests/tripAdvice.test.ts`：15/15 通过。
- `node --import tsx scripts/verify-generation-flow.mts`：最终版本通过。独立 PostgreSQL 数据库 + 本地 OpenAI 协议模拟模型；真实 SQL 证据进入建议来源，最终结构与保存快照匹配；模型失败仍正常交付；既有事务回滚、取消、通知、闭馆与 SSE 回归通过。
- `BASE=http://127.0.0.1:18861 OUT=.trellis/tasks/10-05-trip-personal-advice/research/browser node --import tsx apps/web/tests/trip-weather-browser.mjs`：桌面/手机布局、来源链接、过期内容隐藏、基础提醒、实时天气及零浏览写入均通过。
- 指定修改文件 `git diff --check`：通过，仅 Windows 换行提示。

## 预览
- [桌面专属建议](browser/personal-advice-1600.png)
- [手机专属建议](browser/personal-advice-390.png)
- [编辑后待更新](browser/personal-advice-stale.png)

图片为页面模拟数据验证，不代表真实模型文案质量；已逐张视觉检查。

## 边界
- 本次未调用真实外部模型，真实生成文案质量留待用户验收。
- 浏览器插件技能已读取，但当前工具目录没有 Node REPL js / tool_search，使用项目现有 Playwright 回归脚本核验。
- 专用测试库位于忽略目录 data/trip-advice-pg；各回归数据库由脚本清理，专用 PG 与预览服务均已停止。
- 验证中发现的测试种子字段错误（updated_at 应为 created_at）已修复，最终回归通过。
- 不修改历史行程；没有 advice 的旧版本保持规则兜底，新生成/重新规划才有专属内容。
