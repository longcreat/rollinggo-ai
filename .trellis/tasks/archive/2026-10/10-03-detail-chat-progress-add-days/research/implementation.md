# 实施与验证记录

## 范围与决定

- 用户确认处理时展开、完成后折叠；复用附件 summary 与真实 SSE progress，新增统一 ChatProgress。
- 日期扩展使用 add_days 一组操作，避免多日请求被单轮 5 条操作限制截断；整趟上限仍为 15 天。
- 第一版新日活动沿用模型草稿与地点解析；追加需求已将其替换为下方的共用调研与排程。
- 明确空白/休息日允许无活动。未定位活动不伪造坐标；既有日期保留。
- 新增/恢复日期同步 Brief 天数和结束日期；不改变普通旅行咨询与明确重新生成入口。
- 工作区已有多个任务未提交代码，本任务仅增量修改，不提交或归档。

## 第一版验证（RAG 追加需求之前）

- 定向纯逻辑、建议生成与客户端流/store 回归：22/22 通过。
- npm run typecheck 与 npm run build 已通过；构建仍提示现有大 bundle。
- 本地端到端回归已通过：隔离 PostgreSQL、本地模型、真实 API 与生产前端。
- 覆盖：新增一天/多天、跨年日期、重复请求不重调模型、15 天上限、事务回滚、只读建议、恢复后天数同步。
- 浏览器覆盖：处理时展开、完成折叠、刷新回看、第 3 天导航、375px 无横向溢出，以及既有停止/历史/保存并发回归。
- 组合请求「再加一天，推荐美食，安排轻松一些」已通过；普通文本先理解整句，避免被美食关键词拦成只读请求。
- git diff --check 通过。没有独立 lint 脚本。
- 内置 Browser 连接返回 iab 不可用，使用项目已有 Playwright 回归验证。
- 未调用真实外部模型/地点供应商，模型理解与地点质量仍需现场验收。

## 验收截图

- `data/detail-chat-verification/progress-running.png`：处理时自动展开。
- `data/detail-chat-verification/add-day.png`：新增第 3 天与完成折叠状态。
- `data/detail-chat-verification/progress-completed.png`：完成后手动展开回看。
- `data/detail-chat-verification/progress-mobile.png`：手机端回看。

## 验收状态

实现与自测已交付，等待用户验收；未提交、未归档、未标记任务完成。

## 混合 RAG 与调研复用（2026-10-03 追加需求）

- 新增 `detailKnowledge`：当前问题、选中日期/行程地点、偏好与相关最近问题进入检索；SQL 与独立自然语言语义查询融合，保留强弱证据与原始介绍。实体归并不丢语义分。正式生成仍默认 SQL-first。
- 问答、美食和追加调研共用 `detailSources`：网页最多 2 次、地点最多 4 次，查询去重，沿用编辑器配额预留和结算。缺配置/超额/无结果明确说明；账本错误阻止落库。
- 时效问题、明确联网或库内不足按需搜索；用户说不要联网时不调用。参考资料附件最多 8 条，带地点名/来源标题，刷新后可展开查看，旧消息兼容。
- 抽取 `runResearchPhase`，新行程生成和追加日期共用调研工具、来源/简介规则；追加部分通过同一确定性排程器处理实际日期、闭馆、节奏和地点关系。
- 模型的 add_days 内容仅作需求草稿；追加只接受已检索库内实体或本轮真实地点结果，排除旧景点主名/已知别名，不采信模型编造链接。正常日期至少有一个真实候选，否则整轮失败。
- 连续非休息日按真实日期分段排程；明确空白/休息日不调研也不自动补活动。合成餐次/自由安排不定位为具体店铺；真实餐厅按原名解析。
- SSE 进度最多 20 条，仍是处理时展开、完成折叠；不输出原始推理或工具参数。
- 网页和天地图适配器贯穿 AbortSignal，取消结果不写缓存；流式请求整轮 5 分钟兜底。旧 /messages 的追加日期委托同一详情服务，保持单次理解和原子保存。

### 验证证据

- 75 项定向测试通过：detailKnowledge、researchSubmission、researchQuality、scheduling、queryEmbedding、chatEditOps、followUpSuggestions、前端 detail-chat/editorStore。
- 34 项来源与取消回归通过：detailSourceCancellation、tianditu、detailKnowledge。与上一组重叠 6 项，共 103 个独立测试。
- DB 相关测试均在本机 18797 临时隔离库运行，退出后删除测试库，不改业务数据。
- `npm run typecheck` 与 `npm run build` 通过；构建保留既有大 bundle 提示，没有独立 lint 命令。
- `node --import tsx scripts/verify-detail-chat.mts` 验证真实 API、模拟增量模型/搜索、生产前端：实际 submit_research、简介/来源复用、连续追加不重复、跨年日期、故障和取消回滚、旧接口、空白日、网页参考持久化、浏览器展开/折叠、导航与手机布局，以及既有保存和历史回归。
- 停止请求测试用显式门闸等待调研开始，并断言停止 API HTTP 200；携带 JSON Content-Type 时必须发 `{}`，不能把空 JSON 请求的 400 当成已经停止。
- 截图仍位于 `data/detail-chat-verification/`，其中 add-day.png 展示真实调研 fixture 的第 3 天与参考链接。
- 本机隔离 PostgreSQL 未安装 pgvector，API 回归验证如实降级；独立检索测试注入向量结果验证融合、实体去重和失败兜底。不声称本机已启用真实向量索引，也未做全库向量回填。
- 未使用真实外部模型/搜索/地图供应商进行质量验收；线上向量能力依赖原有 Embedding 配置、pgvector 与已有向量数据。

实现与自测不等于用户验收；本轮保持 in_progress，不提交、不归档。

## 最新回答建议缺失修正（用户纠正后的范围）

- 用户明确纠正：只在最新回答完成后显示 2～3 条相关建议，不在每个历史回答后同时展示。
- 原建议工具允许 0～3 条，8 秒超时/无有效工具输出时返回空数组；已改为要求 2～3 条，并关闭可配置的 DeepSeek thinking。
- 共享 `completeFollowUpSuggestions` 按最新回答的主题与实际原文片段补足不足两条的结果；不从旧问题或寒暄推断主题，不创造新事实。
- 服务端保存补足结果；前端仅对最新完成回答兼容已有空建议记录，刷新即可显示，不额外调模型、不改写历史数据。
- 修复首条修改回答被 `relatedTripId` 当成初始关联记录而截去的问题：带 attachment 的真实回答保留。
- 原有只显示最新一组、pending 隐藏、澄清问题显示 2～3 个回答选项的交互保持。
- 定向测试 7/7 通过，覆盖两/三条保留、单条补足、去重、模型无工具/错误/超时与真实取消。
- 浏览器回归增加：无初始关联消息的首次修改、模型返回空建议、已有空附件刷新补足、两条最新建议显示及旧组隐藏。
- 上述 API/浏览器回归已通过，`npm run typecheck`、`npm run build` 与 diff 检查通过；新增截图 `data/detail-chat-verification/latest-suggestions-fallback.png` 已检查。
- 本轮仍待用户验收，不提交、不归档。
