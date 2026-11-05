# 交付自查（等待用户验收）

实现与自测已具备交付条件；用户只确认了“出行手册”标题，尚未验收实现。任务保持 in_progress，不提交、不归档、不执行会话收尾脚本。

2026-10-04 追加：天气由高德换为和风（见 research/qweather-api.md），跨度 4 天 → 15 天，凭据改为站点级 `QWEATHER_API_HOST` + 和风凭据（JWT 私钥现签优先，静态 JWT 与 API Key 降级）；下列验证均为换源后重跑结果。

## 已验证

- `npm run typecheck`：通过。
- `npm run build`：通过；沿用现有单包体积提示。
- `node --import tsx --test apps/server/src/__tests__/qweatherWeather.test.ts apps/server/src/__tests__/qweatherRequest.test.ts apps/server/src/__tests__/amapRequest.test.ts apps/web/tests/tripAdvice.test.ts`：22/22 通过（含 JWT 验签、认证头与提前重签、坏私钥不耗额度）。
- 自查发现并修复的三个真缺失：适配层未剥掉和风风向的「风」后缀（页面会渲染成「北风风」）、单日字段非法会拖垮整份 15 天预报（改为按天单独校验，已加单测与浏览器断言）、验证脚本会读到开发机 `.env` 里的真实凭据（现强制清空）。
- 用户实际采用 JWT（不是 API Key）后补上签名链路：`QWEATHER_JWT_*` 四项 + Ed25519 现签；静态 token 与 API Key 作为降级路径。
- 全量 `node --import tsx --test --test-concurrency=1 apps/server/src/__tests__/*.test.ts`：509/510；唯一失败是 `chatDerive.test.ts` 的 `未配置 AI 的错误按 hasSiteKey 分流`，该用例用三个参数构造 `ApiError` 而 4 参签名（`code` 为第四参）已由 10-03 响应契约改动引入 —— 与天气换源无关，换源前即失败，未在本任务修复。
- `node --import tsx scripts/verify-trip-weather.mts`：本地一次性数据库，所有和风请求模拟，且走**真实 JWT 现签链路**（断言上游收到的 token 能用公钥验签）。登录/归属、统一响应、缓存、持久日额度、无凭据、历史/远期/未定日期、旧行程不写版本、生成形状快照往返均通过，临时数据库已清理。
- `node --import tsx apps/web/tests/trip-weather-browser.mjs`：1600/768/390px，通过默认总览、天气按天、建议两栏、取消手动刷新后的进入即查、加载态、错误/未配置/远期/未定四种状态与零保存请求检查。本轮按参考图重排后重跑通过。
- `npm run typecheck`（共享/server/web/eval）：按参考图重排后重跑通过。
- `node --import tsx apps/web/tests/route-options-browser.mjs`：通过。首次运行因开发服务器刚热更新出现一次超时，重跑全绿。
- `node apps/web/tests/handwriting-browser.mjs`：9 项实际字体渲染检查通过，无写入。
- `node apps/web/tests/route-options-browser.mjs`：默认总览后显式选日，既有路线预取、优先级、切换、串行保存、重试、移动端及 Escape 全部通过。截图位置从归档任务改到 verify-shots，避免改写历史验收产物。
- `scripts/verify-generation-flow.mts`：通过初始化失败/取消、事务回滚、完整生成、版本链、事务中与提交后取消、终态 SSE 等全部现有检查。使用本地一次性数据库及模拟 LLM，不调用真实外部供应商。
- `git diff --check`：通过。

## 截图

- `verify-shots/trip-weather/overview-desktop.png`
- `verify-shots/trip-weather/overview-390.png`
- `verify-shots/trip-weather/day-desktop.png`
- `verify-shots/trip-weather/day-390.png`
- `verify-shots/trip-weather/cautions-desktop.png`

截图中的路线及天气为浏览器测试样例，天气不是实况证明；底图网络未成功显示，不作为本任务地图验收依据。新增天气接入按官方协议和模拟响应验证，**尚未使用真实和风凭据做上游联调**（凭据位置已备好，填入即可）。

## 工作区范围

本任务涉及共享 weather 合约、Trip 可选快照、高德 weather 适配与独立计量、生成保存前查询、天气 GET、详情 React Query、出行手册/每日天气/建议与默认总览，以及相应测试规范。

开始时已有账号偏好、个人资料、补图任务的未提交改动；保持原样并兼容。共享修改文件（`.env.example`、`schemas.ts`、`routes/trips.ts`、spec 索引等）在未来提交前需按任务范围审阅，不能将已有任务改动误归入本任务。
