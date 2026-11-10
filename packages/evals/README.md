# 评估运行说明

本目录提供历史快照回归、当前生成链路 live 评估、版本比较与显式基线接纳。每次运行写入独立目录，不覆盖历史快照。

## 日常命令

在仓库根目录执行：

```powershell
npm run eval:test
npm run eval
npm run eval -- --suite smoke
npm run eval -- --case shanghai-3d-transit
```

- `full`：现有全部 9 例。`smoke`：上海常规、北京远郊、重庆地形 3 例。
- 默认输入：`eval/snapshots/`；`--snapshots <目录>` 可重放其他输入。
- 输出：`eval/runs/<时间-随机ID>/`，终端会给出完整路径。可用 `--out <目录>` 更换运行根目录。
- 离线模式不调用模型、不连接数据库，只检查历史最终行程。当前功能流程用 `eval:flow` 实际执行，真实模型/知识质量用 frozen live 验证，两者分别记录结果。

## 详情页 Agent 回归（eval/agent）

确定性层——不调模型、不连库，已随 `npm run eval:test` 进 CI：

```powershell
npm run eval:agent
```

覆盖 6 项：分流矩阵（咨询走 Agent；修改/建议/美食/澄清/开关关闭都不走）、工具集只读且完整、工具输出不截断、行程快照全量、同用户并发 409、停止后释放锁。

真实层——真模型 + 高德/搜索，会产生调用费用：

```powershell
doppler run -- npm run eval:agent:live
doppler run -- npm run eval:agent:live -- --only facts,day-scope
```

覆盖 5 项：行程事实、单日范围、地点检索、时效检索、只读边界（行程对象不被改动）。缺 `AMAP_KEY` / `SEARCH_API_KEY` 时对应场景自动跳过。

## 根据现有功能验证完整流程

```powershell
$env:EVAL_PG_ADMIN_URL = 'postgres://postgres:postgres@127.0.0.1:5432/postgres'
npm run eval:flow
# 只列出验证范围
npm run eval:flow -- --list
# 显式跳过生产构建和浏览器；报告为 PARTIAL，不能作为完整验收
npm run eval:flow -- --no-browser
```

默认执行 12 个环节：评估器回归；当前输入转换/检索/调研/排程等单测；生成事务与 SSE；live 采集；调研纠正/拒绝；账号偏好；路线选项；天气；生产构建；首页到详情；详情对话与历史恢复。每个数据库脚本自建/清理专用库；子进程禁止公共 fetch，模型与地图使用本机 mock，天气使用受控响应。

结果在独立 `eval/runs/flow-<时间>/flow-report.md` 与 `flow-report.json`，逐环节链接日志。失败后继续其他独立环节，构建失败会跳过依赖它的浏览器；只有全部 PASS 才是完整通过。需本机 Chrome（Windows 默认安装路径或 CHROME_PATH）/ Playwright Chromium（`npx playwright install chromium`）。[功能到验证映射](current-function-coverage.md) 说明每项到底验证了什么。

## 报告怎么看

| 文件 | 内容 |
| --- | --- |
| `report.md` | 可直接阅读的门槛、指标和问题列表 |
| `report.json` | 结构化逐例状态、指标、问题及运行 manifest |
| `manifest.json` | 输入/检查器/prompt/代码内容 hash、Git HEAD/dirty、知识库与配置摘要 |
| `snapshots/<caseId>.json` | 本次实际检查的快照；校验失败的 JSON 对象也保留 |
| `cases/<caseId>.json` | 单例结果，便于定位问题 |
| `events/<caseId>.json` | live 终态、阶段事件、候选池及累计用量；失败也保存已采集数据 |
| `knowledge/` | frozen 模式的原始压缩副本与摘要，随运行保存以便重现 |
| `inputs/*.invalid.json.txt` | 无法解析的原始 JSON 文本 |

状态：`PASS` 达到门槛；`FAIL` 存在质量违规；`ERROR` 环境、采集、格式或执行错误；`SKIPPED` 缺输入或取消后未执行。后三者都不通过整次运行门槛。

退出码：`0` 通过；`1` 质量失败、缺例或明确退化；`2` 使用/执行错误或比较不可比。任何非零都应阻止将本次运行当作通过。

门槛是零 hard、零结构问题、坐标可信、无缺例，以及已采集的当前流程契约无 FAIL。soft、研究采用率、性能与服务调用是观测指标。预算功能已经删除，预算/费用既不评分，也不提示“缺失”；旧 JSON 中的兼容字段继续保留，但不参与输入比较。

报告区分“单例 / 部分用例 / 全组”，`--case` 跑一例不代表整组通过。live 报告表示本次实际执行生成；offline 表示检查已保存行程，耗时/token 沿用原快照，本次没有加载知识库。

“每日时间与交通覆盖”与 `limitations` 说明实际检查到的范围：

- 当前产品按活动顺序排程，不要求具体时刻；不把空时刻当作缺功能。旧行程已有时刻时仍执行既有时段检查。
- 活动间交通只统计已保存的相邻路段，不含未记录的住宿往返。单景点日没有活动间路段，显示 `—`；缺住宿时不能推断去长城或环球影城无需交通。
- 未给日期时闭馆日检查不适用；未指定住宿时不强求住宿往返。指定了住宿但缺路线时才列为增强降级。
- 周边就餐区域不是已核实门店，其坐标只是参考点。区域与景点相同坐标带来的零距离，不等于实际无需步行。
- 候选采用率是活动名称命中候选池的比例，不是候选使用率或地点准确率。上述范围限制不属于采集故障，不会直接变成 live ERROR。

检查口径升级后，用原快照生成新报告，不修改旧报告；旧/新检查 hash 不同不能直接作版本优劣比较：

```powershell
npm run eval -- --case beijing-5d-family --snapshots eval/runs/2026-10-04T13-17-19-490Z-5f128733/snapshots
```

旧快照缺少研究、耗时或 execution 时显示 `—`/`unavailable`，不能解读为 0。新 live 必须包含非空候选池、三阶段耗时、总耗时、token、各服务计数及流程执行记录；采集不完整为 ERROR。服务调用计数是 wrapper 接受的尝试（可能含缓存），不是计费账单或确认出网次数。阶段可能并行，不能把阶段耗时直接相加当成总耗时。

“当前流程检查”追踪检索/调研提交、确定性排程、标题、地理增强、远郊/跨天处理、最终路线、输入保留、偏好餐次、住宿约定及事务读回。必要步骤或结果契约违反为 FAIL；标题/地图等可选增强为 DEGRADED；缺执行证据为 UNAVAILABLE；输入不要求该功能为 NOT_APPLICABLE。增强失败后恢复成功不会误判成未执行。历史快照没有 execution 时只能作为历史最终结果检查，不能补造流程成功记录。

## Live：执行当前生成链路

### 全城市偏好与备注矩阵（真实模型）

2026-10-05 冻结版 `kb-2026-10-05-matrix` 包含 5,021 地点、7,102 证据和 270 关系，新增济南。云南按本轮要求不执行生成；11 个其余城市各测 3/5 日 × 无偏好/美食/历史/自然，共 88 例，另加北京 8 个备注场景。历史对应当前「文化」枚举与明确历史主题的备注。统一 2026-10-19 出发、2 人、moderate、transit。

```powershell
$env:EVAL_PG_ADMIN_URL = 'postgres://postgres:postgres@127.0.0.1:5432/postgres'
npm run eval:campaign -- --knowledge-snapshot eval/knowledge-snapshots/kb-2026-10-05-matrix
# 单城或单例；写入全新的运行目录
npm run eval:live -- --suite matrix --city 北京 --knowledge frozen --knowledge-snapshot eval/knowledge-snapshots/kb-2026-10-05-matrix
npm run eval:live -- --suite notes --case beijing-notes-avoid-palace --knowledge frozen --knowledge-snapshot eval/knowledge-snapshots/kb-2026-10-05-matrix
# 汇总已经结束的批次（正在运行批次明确算待完成）
npm run eval:campaign:report -- eval/runs/<campaign目录>
# 对同城同天数的行程做真实模型语义审阅，可等待后续批次
npm run eval:campaign:review -- --campaign eval/runs/<campaign目录> --watch
# 带备注的详情对话与理解模块；默认每例重复两次
npm run eval:intent -- --snapshot eval/runs/<运行目录>/snapshots/matrix-beijing-3d-none.json
```

`eval:campaign` 按城市串行、每批专用库，完成 12 批共 96 次生成后退出。独立批次失败后继续；不会自动重跑失败来覆盖原结果。`--resume <活动目录>` 只继续未开始批次，核对输入/运行代码/知识 hash；遇到运行锁或半份批次先核对进程，不自动删除或重跑。批次内地图额度仍按既有 live 默认配置执行，服务拒绝或降级必须记入结果。

`summary/report.md` 汇总生成门槛与覆盖；`place-coverage.json` 包含每条知识 ID 的候选/入选场景，`uncovered-places.md` 列完全未覆盖的可选地点，`not-selected-places.md` 列全部未入选记录及排除原因。身份关联仅使用同城唯一名称或显式别名，最终活动优先通过候选运行 ID 回溯；歧义和合成餐区单列。这证明已提交候选/行程中可识别的知识地点覆盖，不是数据库全部召回轨迹，也不是事实正确率。

`semantic/review-report.md` 是另一个真实模型的审阅调用；当前复用生成模型，存在共同偏差，结论必须结合活动证据复核。模型判断不能替代明确的必去/避开规则或来源核实。失败组用 `--group <组名> --out <新目录>` 显式复核，原记录保留。

最终再运行 `npm run eval:campaign:audit -- --campaign <活动目录> --reviews semantic,<实际复核目录名>`，检查审阅输入 hash、用例覆盖、结构化活动 ID 以及正文 ID/缩写是否属于本例；采用结果写入 `semantic-audit.md/json`。不会按 aligned 标签挑选结果，只按显式目录顺序采用有效版本。未完成/采集错误返回非零退出码；语义 mixed/misaligned 保留为质量结论。代码或模型变化后用新审阅目录，不能覆盖旧结果。

首页备注直接进入生成调研，详情对话才调用 `understandMessage`。意图测试分别覆盖当前详情路径与理解模块补充契约，报告记录模型判断和归一化 Brief；它不执行编辑/事务，保存行为由 `eval:flow` 验证。真实生成通过、意图通过和语义符合是三个不同结论。

先准备一个**本机用于评估的 PostgreSQL 实例**。管理用户需要 CREATEDB 权限。只接受 `postgres://...@127.0.0.1:<port>/postgres`（也支持 localhost/::1）；拒绝应用库、远端主机与 query 参数覆盖。

```powershell
$env:EVAL_PG_ADMIN_URL = 'postgres://postgres:postgres@127.0.0.1:5432/postgres'
npm run eval:live -- --suite smoke
```

模型配置：`SITE_LLM_BASE_URL`、`SITE_LLM_API_KEY`、`SITE_LLM_MODEL`；地图配置：`AMAP_KEY`。可选 `SEARCH_API_KEY`、`SEARCH_API_BASE_URL`、`EMBEDDING_*`。配置优先级为当前 shell → `apps/server/.env` → 根 `.env`，仅加载白名单字段，不加载其中的数据库或主密钥。

实际过程：创建随机 `rollinggo_trip_eval_<24位hex>` 库 → 覆盖 `DATABASE_URL` 与独立随机主密钥 → 导入应用并迁移 → 导入所选知识库 → 执行生成 → 保存产物 → 关闭连接并删除本次库。live 不会连接应用 `DATABASE_URL`。库内 `eval-user` 是独立测试用户，无登录密码。

固定种子 `fixtures/places.json` 含从 7 月历史金集提取的 87 个景点，无用户数据、向量或实时营业信息。默认 `--knowledge golden` 测固定 SQL 知识库路径；`--knowledge empty` 明确测空库降级，两者 manifest/hash 不同。旧金集种子不足以证明泛化检索质量。

种子保留历史坐标系；旧快照缺少声明时按 WGS84 处理，入库前统一转换为当前知识库要求的 GCJ-02。历史简介仅作为测试素材，不冒充经过最新来源验证的提纯内容。

也可使用 `--knowledge frozen --knowledge-snapshot <目录>`，导入真实知识库的冻结副本。三种模式的用途：

| 模式 | 知识来源 | 用途 |
| --- | --- | --- |
| `golden`（默认） | 固定 87 个历史金集景点 | 快速且可随代码分发的链路回归 |
| `frozen` | 指定版本的真实地点、证据、关系及向量 | 在相同真实知识输入下比较生成版本 |
| `empty` | 空知识表 | 检索缺失时的降级场景 |

知识库输入范围与评估题目是两回事：切换 frozen 后，候选知识不再局限于金集地点，但 smoke/full 仍使用现有 3/9 个固定请求，不会自动新增评估题目。

图片与天气外部服务在此批评估中关闭，manifest 明确记录；它们的产品效果应由独立场景验证。缺地图凭据时仅可显式使用 `--allow-no-geo`，仍执行地理门槛，不豁免坐标不可信的结果。

单例默认最长 600000ms，可用 `--timeout-ms 1000..600000` 缩短。Ctrl+C/SIGTERM 会取消当前任务并尝试清理。所有 live 在本机通过 `eval/data/live.lock` 互斥；进程被强杀后，先确认 PID 已结束，再手动处理遗留锁及相应评估库，不要批量删除未知数据库。

额度设置仅作用于本次评估库内计数，不是跨运行共享的每日总预算：

- `EVAL_AMAP_DAILY_BUDGET`：默认各 LBS 服务 700；地点搜索默认 100。
- 可通过 `EVAL_AMAP_GEOCODE_DAILY_BUDGET`、`EVAL_AMAP_PLACE_DAILY_BUDGET`、`EVAL_AMAP_WALK_DAILY_BUDGET`、`EVAL_AMAP_CYCLE_DAILY_BUDGET`、`EVAL_AMAP_DRIVE_DAILY_BUDGET`、`EVAL_AMAP_TRANSIT_DAILY_BUDGET` 单独调整；受现有月额度校验约束。
- `EVAL_SEARCH_DAILY_BUDGET=100`。

## 真实知识库冻结副本

当前已准备：`eval/knowledge-snapshots/kb-2026-10-04/`，包含 11 个地区、4,841 个地点、6,882 条证据、270 条关系，以及 11,723 条 1024 维向量；模型配置记录为 `cf/bge-m3`。详见该目录的 `manifest.json`。苏州、西安、青岛在源库中仍只有金集地点、没有研究证据；副本保留了这个覆盖缺口。

已有副本可直接验证、再用于真实生成：

```powershell
$env:EVAL_PG_ADMIN_URL = 'postgres://postgres:postgres@127.0.0.1:5432/postgres'
# 不调用模型或地图：隔离导入、三表内容校验、检索与向量查询验证
npm run eval:knowledge:verify -- --snapshot eval/knowledge-snapshots/kb-2026-10-04
# 调用已配置的真实模型和地图
npm run eval:live -- --knowledge frozen --knowledge-snapshot eval/knowledge-snapshots/kb-2026-10-04 --suite smoke
```

需要更新知识输入时，显式导出一个新版本：

```powershell
# 默认读取现有应用 DATABASE_URL，仅用于只读导出；也可设置 EVAL_SOURCE_DATABASE_URL
npm run eval:knowledge:export -- --name kb-2026-10-05
# 或只冻结指定城市，名称必须与已有版本不同
npm run eval:knowledge:export -- --name kb-beijing-shanghai-v1 --cities 北京,上海
```

- 源连接：`EVAL_SOURCE_DATABASE_URL` 优先于 `DATABASE_URL`；配置文件优先级为 shell → `apps/server/.env` → 根 `.env`。导出使用独立原生 PostgreSQL 客户端，在一个 `REPEATABLE READ READ ONLY` 事务内读取三张知识表，不加载应用连接模块、不迁移源库、不读取账号/会话/私人行程表。
- 目标连接：验证和 live 使用 `EVAL_PG_ADMIN_URL` 创建随机空评估库。目标知识表非空时拒绝导入，三表导入在同一事务完成。
- 数据：保留原 ID、城市、分类、坐标、已验证/重定向状态、评分、开放/预约/停留信息、生成使用的内容、证据来源和关系；payload 使用字段白名单，不复制原始笔记、作者资料或图库资产。冻结值不代表信息仍然最新。
- 完整性：`knowledge.json.gz` 保存完整数据；`manifest.json` 展示版本、内容 hash、覆盖和计数。加载校验压缩内容、引用、城市覆盖和向量维度，不能只修改 manifest 来替换输入。源地址与凭据不写入副本。
- 向量：默认保留已有向量，目标 PostgreSQL 需要同维度 `pgvector`，查询模型应与副本记录一致。不满足时明确失败；如需只测 SQL 检索，给验证/live 命令加 `--skip-vectors`，live 同时关闭查询 embedding，并记录不同的有效知识 hash。导出时 `--without-vectors` 可创建本来就不含向量的另一版本。
- 版本：同名导出拒绝覆盖。每个 frozen 运行会保留原始副本，即使显式跳过向量；接纳基线时一起保留，重现时沿用 manifest 中的向量条件。改变副本或跳过向量后，与原运行比较会显示不可比。
- 存储：副本可能较大（本次 gzip 约 51 MiB），`eval/knowledge-snapshots/` 与运行目录默认被 Git 忽略。需要共享时，通过受控文件存储传递整个版本目录并保留 checksum。当前 GitHub 手动 live 工作流仅支持 golden/empty；frozen 从本地 CLI 运行，CI 不读取真实源库。

## 比较两个版本

```powershell
npm run eval:diff -- eval/runs/<基线运行> eval/runs/<候选运行>
npm run eval:diff -- eval/runs/<基线运行> eval/runs/<候选运行> eval/runs/<候选运行>/diff
npm run eval -- --baseline eval/runs/<基线运行>
```

比较按 caseId 对齐。模式、检查器口径、用例输入、live 知识库或服务启用条件变化时明确报告不可比；缺例也不会静默取交集。缺指标的差值是 `null`/`—`，不表示改善。JSON 包含全部数值指标差异，Markdown 展示关键变化。模型与 prompt 变化是允许比较的实验变量，其配置和 hash 可在 manifest 查阅；差值不等于统计显著性。

## 接纳基线

人工检查报告和行程，确认可以作为后续比较基准后，显式执行：

```powershell
npm run eval:accept -- eval/runs/<已验收运行> reviewed-2026-10
npm run eval -- --snapshots eval/baselines/reviewed-2026-10/snapshots
```

接纳命令重新检查每份快照、校验内容 hash，拒绝失败/缺例/篡改/检查器已改变的运行，并拒绝覆盖同名基线。frozen 运行还会校验并复制冻结知识库；缺失或与运行 hash 不一致时拒绝接纳。单例或 smoke 基线应按相同 `--case`/`--suite` 重放。基线包含快照、报告和所需的 frozen 副本，可以独立于原运行目录保留；需要版本管理时，将新基线目录纳入正常人工验收和提交流程。不会自动 Git 提交。

## CI 与不花真实额度的验证

`ci.yml` 的独立 eval job 执行 9 例离线评估、完整 `eval:flow`（含浏览器）及合成知识库导出/导入自测；成功失败均上传 `eval/runs/`（保留 14 天）。

餐饮顺路规则的纯函数回归和隔离生成流程也纳入该 job：有坐标的门店须距前后景点之一不超过 2 km，午餐额外直线绕行不超过 2 km；否则如实使用周边区域。规则约束选餐阶段，不保证后续实际路网通勤时长。

```powershell
$env:EVAL_PG_ADMIN_URL = 'postgres://postgres:postgres@127.0.0.1:5432/postgres'
npm run eval:verify
npm run eval:knowledge:verify -- --self-test
# 用真实冻结知识输入验证 live 采集，模型与地图仍为本机 mock
npm run eval:verify -- --knowledge-snapshot eval/knowledge-snapshots/kb-2026-10-04
```

验证预加载会拦截公共 HTTP、给出固定地理响应，并记录所有 PostgreSQL 连接。测试断言完整采集、只连接管理库/评估库、评估库与锁已清理、产物未泄露测试凭据。mock 通过证明执行与采集链路可用，不代表真实模型质量。

模型未按工具协议提交的回归场景（同样不调用真实服务）：

```powershell
npm run eval:verify -- --research-response text-first
npm run eval:verify -- --research-response text-only
```

前者模拟先输出正文 JSON，再经一次提醒成功调用提交工具；后者始终输出正文，应在调研阶段明确失败，不生成空候选占位行程。

知识库自测使用自行创建的临时源库，检查导出稳定性、城市筛选、私有字段排除、未验证/重定向记录保留、证据关联、非空目标保护，以及缺少向量列时拒绝导入/显式跳过。它不会连接应用知识库。

`eval-live.yml` 只提供 GitHub Actions 的 **Run workflow** 人工入口，不自动定时调用。需配置专用 secrets：`EVAL_LLM_BASE_URL`、`EVAL_LLM_API_KEY`、`EVAL_AMAP_KEY`；变量 `EVAL_LLM_MODEL`；可选 secrets `EVAL_SEARCH_API_KEY`。结果保留 30 天供下载比较，不自动接纳基线。

每个 PR 看离线结果；模型/prompt/检索/排程变化后人工触发 live smoke；发布前跑 full 并抽看行程。发现的问题应记录输入、预期与失败原因，下一批持续扩充场景回归。

## Live 故障定位

- `live 观测不完整：research`：检查 `events/<case>.json` 候选和工具记录。若调研没有成功调用 `submit_research`，正文里的候选 JSON 不会入池。当前版本会保留上下文提醒一次，仍未提交则明确失败；历史失败报告不会自动改成通过。
- `HTTP 504` / HTML 网关错误页：模型请求的网关/上游连接失败或超时。现有请求级重试仍生效，重试次数不代表问题已解决。对齐 `SITE_LLM_BASE_URL`、模型与该网关的可用性；优先单例复测，避免直接重复三城的慢请求。
- `生成超时`：单例上限默认 600000ms，调研、编排和文案共享这个时间；调研用掉约 8 分钟后，文案只剩约 2 分钟。报告保留终态原因和部分耗时，不能当作质量通过。
- 和风凭据提示：本批评估主动关闭天气服务，与调研候选或模型网关错误无关。

`events` 新增工具名称、错误标志、耗时和模型响应的阶段/轮次/停止原因/HTTP 状态，不保留原始请求、工具参数或网页错误正文。已启动的旧进程继续使用旧代码；它结束或在原终端 Ctrl+C 清理后，新运行才会使用修复。
