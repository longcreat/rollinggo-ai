# 地点身份治理运维说明

## 日常处理

上游执行目录为 `D:/Project/xhs-travel-pipeline`，Python 使用该仓库 `.venv/Scripts/python.exe`。下游导入及向量脚本执行目录为 `D:/Project/tripweaver/apps/server`，以便加载正确环境。

首次初始化执行 `scripts/migrate_place_identity.py --apply` 及 `scripts/govern_place_identity.py --bootstrap --apply --out <报告路径>`；本次已完成，无需重复初始化。之后每次聚合使用同一注册/解析入口；新增相似地点 REVIEW 状态不会导出。

审计某城（不带 `--apply` 不提交数据库）：

```powershell
.venv/Scripts/python.exe -B scripts/govern_place_identity.py --city 济南 --out D:/Project/tripweaver/.trellis/tasks/10-06-place-identity-governance/research/jinan-review-next.json
```

为待审项核实原始提及、主名、行政区、独立边界、地址和地图 POI。相似度仅帮助发现候选；`part_of`、历史片区、独立入口、分店不应提交为同义合并。

确认同义时以 [jinan-decisions.json](jinan-decisions.json) 为模板，填写唯一 `key`、`city`、主 `entityId`、被并 `mergeEntityIds`、`expectedRevisions`、别名和证据。只新增别名或改主名时 `mergeEntityIds` 可为空，主实体 ID 不变。坐标修复必须成对给出经纬度；使用 GCJ-02，不平均冲突坐标。

```powershell
.venv/Scripts/python.exe -B scripts/govern_place_identity.py --city 济南 --decisions <决策JSON路径> --out <预览报告路径>
.venv/Scripts/python.exe -B scripts/govern_place_identity.py --city 济南 --decisions <决策JSON路径> --apply --out <应用报告路径>
```

只有核实通过的决策才执行第二条。相同 key 同请求重复执行幂等；不同请求不能复用 key；预期 revision 过期必须重新检查。已回滚的决策不能直接重放。

## 导出与下游验证

上游重导 `scripts/export_to_tripweaver.py --city 济南 --out <独立的新导出路径>`。图片/摄影导出必须使用同一持久 entityId，不根据当前名字重新计算 ID。

下游：

```powershell
node --import tsx scripts/seed-xhs-places.ts <地点导出路径>
node --import tsx scripts/embed-backfill.ts --tables places --city 济南
```

地点导入先于图片导入。存在图片清单时再运行 `scripts/seed-xhs-place-images.ts <图片导出路径>`；无法解析的 ID、歧义或不适合借用的组成地点会计入跳过告警。

一次导入保存城市前后快照并输出审计 ID。旧 v1 和已重定向成员不能复活；v2 revision 回退或同版本改身份声明会失败。重复导出可更新内容，身份集合换顺序不造成冲突。

每次治理后核验：各别名 SQL 与向量同 ID、入池/编辑无重复、子项负例独立、坐标/类别正确、图片归属保留、旧导出重跑不复活。当前固定样本探针：

```powershell
node --import tsx D:/Project/tripweaver/.trellis/tasks/10-06-place-identity-governance/research/verify-live-identity.mts
node --import tsx D:/Project/tripweaver/.trellis/tasks/10-06-place-identity-governance/research/verify-import-guards.mts
```

## 本次回滚信息

回滚前暂停同城导入/治理；必须先预览。下游按导入顺序倒序回滚，先最新 `8a16d1e2-b251-4de8-b8e1-08987dc75ab7`，再首次 `1a46f329-a24b-4cce-8163-211fb5f2d282`。

```powershell
node --import tsx scripts/rollback-place-identity.ts 8a16d1e2-b251-4de8-b8e1-08987dc75ab7
```

不带 `--apply` 只验证，返回 `restored:false` 表示没有执行恢复。正式恢复才追加 `--apply`。如果已有后续业务修订则拒绝覆盖；仅向量派生更新不会阻碍预览。本次只执行过预览。

上游对应 key 为 `jinan-20261006-daminghu-v2` 和 `jinan-20261006-shangbu-v2`：

```powershell
.venv/Scripts/python.exe -B scripts/govern_place_identity.py --city 济南 --rollback <治理key> --out <回滚预览路径>
```

核实报告后加 `--apply` 才恢复上游快照。上下游回滚应协调执行：先恢复下游导入快照，再回滚上游治理；不能直接拿降低了 revision 的旧导出来覆盖仍处于新版本的下游。恢复后按需要补向量并重新验证名称映射。

## 当前持续治理边界

481 组 PENDING 是全城第一份冻结快照的积压，并非允许自动合并的名单，也不是当前剩余数量。当前进度见 [续作记录](resume-20261007.md)，实库账面数量和按现行实体对去重后的候选数应分别记录。

CLI 的 `--review-decisions <JSON>` 已支持 `distinct / part_of / uncertain`；请求包含唯一key、原reviewFingerprint、现行主体expectedRevisions、explanation与evidence，组成关系另给childEntityId。默认完整事务预演并回滚，确认证据后加 `--apply`。独立/组成结论阻止后续同义合并，uncertain保留PENDING，不计为已解决。

改名不会改写历史审核指纹；入队按现行实体对匹配既有记录。同一实体对因旧成员合并留下多条PENDING时，一次审核原子处理全部历史记录并记录前后快照；回滚也整体恢复。通用审核UI尚未提供。

## 冻结批次与断点恢复

`all-cities/sync-batch.mjs <batch> export|import|embed <sync-NN>` 按城市保存状态和哈希。已导出数据不覆盖，失败产物采用新attempt并记录原因；导入前核验哈希。`embeddingRunAt` 只表示命令结束，覆盖率与真实请求须另验。

每个依赖步骤必须等前序进程退出成功：工具返回session_id时仍在运行，须收取结束后才能继续。同步脚本要求对应`batch-applied.json`存在且`apply:true`。batch-19首次提前导出读到旧主名，被断言拒绝；`sync-01`保留为失败证据且从未导入，正式应用完成后改用`sync-02`。不能将旧应用报告或文件存在本身当成当前进程已完成。

`all-cities/verify-batch.mts <batch> <sync-NN> [--vectors] [--city 城市 --label retry-01] [--ids 实体ID,实体ID]` 只读验证实际库的导出契约、别名/旧ID、照片、重定向与向量。`--ids`仅限定真实向量探针，报告保留vectorIds；用于失败项复核或旧组合新释放子项。复核必须留独立label，保留首轮失败。使用生产embedding配置与2500ms查询超时，不能拿SQL命中或延长超时替代真实向量成功。

上游确认实体即使没有summary/精确坐标也可导出；若原源记录因缺坐标而被评分停用，必须版本化明确批准 `overrides.exportApproved:true` 才放行。该运营字段不输出产品payload，仍遵守显式min-score。坐标未证实则用null并同步geoStatus，不能填主体或其他分店的坐标凑覆盖率。

`all-cities/run-flow.mjs run-NN` 只读冻结12城公共地点身份字段，随后创建本次专用临时PG，验证完整目录与SQL→候选→排程→Trip保存→编辑/重访。不会读取或写入应用用户行程；`cleanup.json` 证明临时库已清理。此验证不模拟外部模型、地图、营业时间或浏览器，不能用于声称这些功能通过。

扩展链路同时冻结上游已应用distinct/part_of审核，核验两个实体分别入池/排程/编辑；源实体未导出的负例单独列为未覆盖，不冒充通过。现行v2重导入、旧格式跳过、重复协调及单跳重定向也在临时库逐城验证。名称歧义保留catalog失败，并单独验证不带ID拒绝、指定ID可分别选择的防护。

餐饮负例不能要求两家候选必定进入同一条择近路线。双餐厅始终同池，分别使用各目标附近真实景点构造场景，报告在`negativeProbes[].scheduleScenarios`逐场记录`targetIds`、`selectedIds`、`exclusions`。无合格锚点时明确未覆盖；两家同时明确添加到行程后的保存/编辑检查仍保留。广州249/251的`flow/run-09/10`为历史失败，`run-11`及后续为修正规则后的复核，不能覆盖旧报告。

旧组合子项也从`components[].canonicalPlaceId`纳入正例与父子负例。食物探针使用冻结目录中的真实附近景点；无坐标/无附近景点时列`scheduleExclusions`，自动排程明确不绑定该门店，再验证用户添加后的保存/编辑。酒店保持不自动排为游览活动。`preview-components.mts`为本轮冻结北京/成都导出的实库事务预演，输出不可覆盖；北京`batch-06/sync-02`已应用，成都`batch-08/sync-02`无身份变化且未导入。

`all-cities/audit-live.mjs run-NN`冻结只读台账，分别报告PENDING行数、现行实体对、已查uncertain与未审数量。`source-snapshot.json`只包含初始候选实体，发现遗漏正式名时用`read-entities.mjs <新文件名> <entityId...>`补充冻结证据；`<batch>-supplements.json`列证据文件，选择项`entityIds`显式列额外主体。不得覆盖原实体或只依赖新补充的名字猜身份。

跨批次审核在`<batch>-prerequisites.json`显式列已应用批次，转换器和隔离预演先重建依赖，按当前根/版本处理；预期版本过期仍由实库拒绝。不能为了通过预演手工随意递增revision。只读预演、失败草稿和有效应用批次均保留，不重放已应用请求。

旧快照的审核成员已重定向时，新合并请求应解析到现行根、去掉已归属该根的历史成员，并从冻结实库审计取预期revision。batch-20由`draft-batch20.mjs`记录审计文件哈希并执行此转换，再在重建batch-02/11的隔离库验证；不是把旧成员再次合并，也不是手工改版本。该生成器输出已经冻结，应用后不要单独运行`build-batch.mjs batch-20`覆盖为初始快照请求。

全目录补查发现没有候选边的同体主体时，可用选择项`reviews:[]`、显式`city`和完整`entityIds`生成独立决策；不能借候选边把第三个独立实体一并吞入。合并后多条历史候选落为同一现行实体对时，只提交一项审核，用`coveredReviews`列出其余历史行；转换器验证这些行确为同一对。

`audit-live.mjs`只统计已经入队的台账，不主动发现新候选。改名/合并后的完整目录须再执行一次治理CLI不带decisions的只读审计，核实新增候选后以独立`--apply --out`报告将候选入队，再生成audit-live快照；这一步只新增审核队列，不重放已应用身份决策。`batch-15`地铁跨海段与全线候选为实证：应用后目录28候选，原台账27，重新入队后才一致。

冻结快照按精确展示名查到的mentions为空，不能直接断言源没有原始提及。先用`read-name-variants.mjs`检查原名标点/括号；需要全城扫描时用`read-pending-variants.mjs <新JSON名> <audit运行名>`按待审根及历史成员的源normalized_name找不同原始名称。匹配只证明存在需复核的来源线索，不等于同一分店。济南batch-22找回穆得·老周家和芙蓉楼芙蓉街店原名；后者能与另一来源原图互证才归并，前者仍缺分店证据。

`flow/run-16`起，每个持久化场景使用独立测试账号，初稿和重访版本仍属于同一账号；不因同城用例超过50个而累计触发100条行程上限，也不修改产品限额。独立/包含负例除了编辑内存对象，还须经createTrip/getTrip保存和读回，并逐ID确认各出现一次。`run-15`厦门5项配额失败保留供复现，不能当作实体身份失败或删除旧报告。

技术契约：[place-identity.md](../../../spec/server/backend/place-identity.md)。

## 原图补证

原笔记公开评论可通过`all-cities/read-note-comments.py <新JSON名> <原笔记ID...> [--pages 1|2|3] [--target-replies]`有限读取，每次最多4篇；只对明确目标名线程另取一页二级回复，每篇最多2线程。使用现有客户端限速/预算，不无限翻页、不发消息、不更新源库。结果仅存文本、评论/回复目标ID哈希、是否原作者及读取边界，不存用户账号和访问凭据。原作者明确店址可用于补证；第三方或平台自动回答仅作线索。缺少target_comment关联时不能按回复数组顺序拼接问答，未完整读取时不能声称评论没有线索。当前无断点游标恢复参数，不重复读取相同前三页凑证据。

`textUnchanged`只比较标题/正文，不证明图片顺序从未变化。若作者评论承认编辑造成图片错位（重庆note73实证），旧评论中的页码必须与当前画面重新核对；不能把旧页码回复直接用于当前图的地点归属。筛选后未命中线索也不等于全部原始评论无相关内容。

当原文指向P9/P14等未被前六张图片分析覆盖的页面，不能把“未分析”当成“无图片证据”。先检查本地转存；没有缓存时，可用`refresh-note-evidence.py <新JSON名> <原笔记ID...>`通过已有登录采集客户端定向重取，最多4篇，源库只读，输出不含作者、Cookie和访问令牌。`textUnchanged:true`只证明标题正文未变，仍须人工核对页码与图片内容。

`freeze-note-images.mjs <新目录> [--source <刷新JSON>] <笔记ID:零起索引,...>`固定公开图片CDN，保留失败目录、来源、哈希；HTTP旧链仅升级同主机HTTPS。403后走正常详情刷新，不自行改日期或删除签名。原图仅供治理核实，不自动作为产品照片导入。

`image-review-context.mjs`将人工观察与原文、刷新响应、图片文件和清单哈希绑定，仍交给原决策转换器生成版本化请求。HANDBELL两篇独立笔记显示同一处门面才合并；泮芳春原图写“多家门店”则继续待审，不能用图片证实拼写就直接断言物理分店相同。

依赖清单必须包含完整历史依赖并按先后排序，例如batch-19依赖batch-10，而batch-10还依赖batch-01-v2，因此显式列为`[batch-01-v2,batch-10,batch-13]`。转换器和隔离预演现会提前检查遗漏/重复；不能手工递增revision消除“预览过期”。batch-19首轮依赖遗漏日志和原草稿清单保留。

依赖批次引用的补充实体也须纳入本批`supplements`；只有prerequisites批次名不足以重建它。batch-23首轮遗漏`xian-batch13-supplement.json`导致生成/隔离失败，补齐后重建、幂等与倒序回滚通过。生成步骤失败必须先修复，不能继续依赖预演；正式应用报告与进程成功退出均确认后才导出。

错抽取的名称不是永久同义词。公交站对面被抽成公交站（459）、多分店被规范化成品牌泛名等问题，需要逐提及分配以及聚合/图片/旧ID兼容机制；现有普通合并会保留全部旧主名，不能直接用于这类纠错。设计边界见[逐提及治理设计](mention-scope-design-20261007.md)，尚未实现，不能把该文档当作已有能力。
