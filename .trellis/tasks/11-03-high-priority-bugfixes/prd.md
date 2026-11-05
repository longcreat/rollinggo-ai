# PRD:修复高优 bug(4 项,经逐条真实性验证)

## 背景

2026-11-03 全项目代码审查 + 证伪式验证确认 14 个问题,其中 8 个为当前可触发的真 bug。本任务修复高优 4 组(5 个 bug),其余(3/6/7 号与潜伏项)随迭代处理。

## 修复项

### Bug 1:跨天地理优化在有住宿坐标时永久空转

- **根因**:`routeCoherence.ts` 的 `actualRouteMinutes`(L176-189)在住宿有坐标时强制要求 `day.legs` 中存在 `lodging` 哨兵 departure/returning leg,缺失即 `return null`;而 `optimizeCrossDayGrouping`(L305-306)对 null 直接跳过。但 geoPipeline.ts:311-313 自 09-22 起不再生成住宿通勤 leg(09-22 决策),`draft.ts:95` 还会主动过滤哨兵 leg。
- **触发**:生成时住宿 geocode 成功(geoPipeline.ts:235-239 会写 `lodging.lat/lng`)→ 必然跳过跨天换块优化。
- **修复**:`actualRouteMinutes` 对缺失的住宿段改用 `heuristicPairMinutes(anchor, first/last, mode)` 回退(与 `heuristicRouteMinutes` L140-155 的估算口径对称);活动↔活动段缺 leg 仍返回 null(真实数据缺失不该猜)。before/after 两次调用走同一函数,住宿贡献在同一次比较中保持一致,交换判定不受影响。
- **验证**:相关单测(geoPipeline/routeCoherence 如有)+ 全量 typecheck。

### Bug 2:dataSources 落库把天地图结果硬编码成 'amap'

- **根因**:`orchestrator.ts:497` `poi.stats.gotResults ? ['amap']`;POI 搜索源自 09-25 起固定天地图(poiTaskSource 包装的 `inner.kind` 才是真实来源,'null' 源不计数不会 gotResults)。
- **影响**:`Trip.meta.dataSources` 持久化失真 → PrintView/PDF 导出来源标注错误。
- **修复**:写 `poi.source.kind`(过滤掉 'null';类型上收窄到 `DataSourceKind`)。

### Bug 4+5:parse-prompt 无限流 + Fastify 未设 trustProxy(绑定修)

- **根因**:①`POST /api/chat/parse-prompt` 公开、烧站点 LLM,但应用层无 `rateLimit` config(`@fastify/rate-limit` 为 `global: false`),反代层 nginx 也无 `limit_req`——全链零防护;②Fastify 未设 `trustProxy`,反代后 `request.ip` 恒为反代地址 → 现有全部限流(登录 5/min 等)全站共享一个桶,加了新限流也会失效。
- **修复**(三处,缺一不可):
  1. `index.ts` 创建 Fastify 实例时设 `trustProxy`(部署拓扑:compose 只绑 127.0.0.1 / 宿主 nginx 前置,socket 对端必为可信反代);
  2. `nginx.host.conf` 与 `docker-compose.release.yml` 内联 nginx 模板补 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`(没有它 trustProxy 拿不到真实 IP);
  3. `routes/promptParse.ts` 路由级 `rateLimit`(对齐 routes/auth.ts 现有声明风格;额度参考登录 5/min,取 10/min/IP——交互式输入场景)。
- **注意**:promptParse.ts 与 index.ts 的部分内容是工作区未提交 WIP(用户进行中的功能),修复叠加其上,提交时需用户确认归属。

### Bug 8:llm_request_logs 无任何清理

- **根因**:每次 API 请求全量快照落库(llmRequestLog.ts:41),server/src 与 scripts/ 全库零 delete,长跑实例存储无界增长。
- **修复**:启动迁移后追加保留期清扫(`DELETE ... WHERE created_at < now() - 7 days`),幂等、单条语句,与 migrate.ts 既有「事务外执行」段一致;保留期常量 + 注释说明取舍。email_verification_codes/detail_operations 的清理留待后续任务。

## 非目标

- Bug 3(抓图 redirect/大小上限)、6(保存假成功)、7(FoodCard 重试)与 6 个潜伏项不在本任务。
- 不动工作区内其他未提交 WIP;不 push;不 --amend。

## 验收标准

1. `npm run typecheck` 四个 tsconfig 全过;
2. `npm run eval:test` 通过;
3. 若本地 PG 可用:`scripts/verify-sql-first.mts --flow` 通过(覆盖 geoPipeline 等);
4. 每项修复有对应 diff,不夹带无关改动;提交按 commit-convention 分批,Phase 3.4 一次性确认。
