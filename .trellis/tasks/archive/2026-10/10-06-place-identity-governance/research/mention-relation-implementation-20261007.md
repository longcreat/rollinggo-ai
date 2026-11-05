# 逐提及关系：实现、安装与验证

## 当前结论

关系解析、独立来源版本、双导出、下游双导入、稳定ID消费和逆序审计已实现并安装。**济南run-02已正式同步，其他城市继续推进**，最新实测见末尾附录，前面数量为历史阶段结果。没有创建实体治理batch27，没有重放batch26或此前批次。完整任务仍未验收，不提交、不归档、不标记完成。

上游实际来源有10城；全城身份消费报告的12城还包括下游独有城市。不能把本轮10城关系只读试算写成12城关系验收。

## 实现边界

- `clean/relation_text.py`提取原有无向规则，旧脚本导入入口仍兼容；`clean/mention_relations.py`逐条核对原提及并绑定原文位置。未确认/低频/未导出地点继续占据位置，不能误连两侧。
- 同篇同名分店以唯一原文引用定位；无定位或同处冲突不能产生端点。已审核泛名只有在完整分店表层本身属于同一目标时可绑定该位置，母项不能借子项位置。
- `clean/relation_snapshot.py`生成完整来源声明及图摘要；`aggregate/relation_snapshot.py`在可重复读事务和城市锁内发布。来源恢复或门槛变化也推进关系revision；普通新增提及不提升实体revision。ORM长会话缓存强制刷新。
- 上游新增`place_relation_snapshot`；常规地点导出自带同版本`xhs-place-relations-*`文件。独立挖掘与常规导出使用同一发布器和文档构造器；完整空图可撤回。后台计数读取新快照，界面移除“可不清理旧边”的过时选项。
- 一键`export_and_embed.ps1`按地点→关系→可选图片→向量执行。任务`sync-batch.mjs`对新导出记录两个哈希与关系导入状态，关系失败时不重放已经成功的地点步骤。已有26批历史状态不补造新字段或重跑。
- 下游新增`placeRelationIdentity.ts / placeRelationSnapshot.ts`及`place_relation_snapshots`。TypeBox与语义校验覆盖整图摘要、支持篇数、双端点位置/提及/原文/实体版本；位置采用Unicode码点。
- 地点导入更新来源声明及本次可用ID，来源推进立即清图并删除旧关系导入记录；本次没导出的旧verified行不能借历史目录消费关系。空数组与尚无图的SQL NULL区分。
- 排程从同一SQL视图读取图与当前目录，以实体ID/revision和受控mentionSources核验。城市接纳新声明后不回退裸名旧图；关系仍只提供同天聚类信号。
- 新快照加入现有地点审计；缺该字段的历史审计不能覆盖后来接纳的快照，正规倒序审计可恢复旧状态。城市锁等待后的关系导入须重验来源。

## 验证证据

1. 核心首轮221项：`upstream-stage-place_identity_test_1791349551346.log`。
2. 完整上游由451、453扩展至454项；最终包含常规双文件导出的结果：`upstream-full-place_identity_test_1791360241930.log`，454通过。
3. 下游35→36→76项相关回归：最终`downstream-place_identity_test_1791359875147.log`，覆盖独立图片、地点导入、撤回、关系、城市锁、保存编辑及逆序回滚。
4. 真实SQL双分店在专用库生成原始提及→scope分配→双导出。`mention-relations-preview-1791359223388/`含初始/来源私密/恢复三组文件及摘要，关系版本1→2→3，实体版本不变，恢复后sourceHash与初始相同而发布号不同。下游实跑SQL候选、排程4地点、保存2行程版本、撤回恢复、旧文件拒绝及7次倒序审计；成功结果见该目录`verification-*.json`。
5. 常规导出的自动配对文件与独立挖掘文件逐字节一致：`mention-relations-preview-1791360118225/`，5项通过。
6. 安装后明确禁用stage注入，运行实际上游模块：`upstream-installed-place_identity_test_1791360585786.log`，5项通过；工件`mention-relations-preview-1791360585786/`。该目录后续下游验证结果以对应`verification-*.json`及日志为准。
7. 全仓typecheck及扩大`tsconfig.verify-joint.json`先前通过；该配置已纳入地点/关系导入脚本、真实关系联测和迁移脚本，最后一轮仍须读取完成结果后记录。

保留失败：`downstream-place_identity_test_1791359371207.log`的首次联测在重访编辑失败，原因是探针用“再次到访”而既有明确重访语法匹配“再去/再次去/重访”。探针改为明确支持的“第二天再去”，未改产品重访规则，后续保存和编辑通过。旧`placeRelations.test.ts`中没有真实北京数据便提前返回的案例，不作为实城关系证据。

## 实城只读试算

`mention-relations-audit-1791359646354191400/report.json`冻结10城当前原提及、身份声明和完整试算图：888关系，其中232条direct。每城约0.24～1.78秒，未发布、未迁移、未导入；受控关系0，没有为展示机制而编造实城分店关系。

未参与原因包含无正文位置、没有逐提及绑定、低频、身份不明确以及4条已撤回咖啡提及；这些位置计数不等于实体对待审数量。原138对uncertain/4提及的核实工作仍需继续。

## 安装与迁移

- `upstream-install-relations-20261007.json`：50个受控补丁文件，12个变化，全部按base/上次安装哈希保护并保存备份。安装器现在支持本次PowerShell同步脚本，并使用PowerShell Parser进行语法检查，不执行脚本。
- 上游预演：`upstream-relation-migration-preview-1791360240188529100.json`；正式应用：`upstream-relation-migration-applied-1791360395109310000.json`。14张旧表全行摘要不变，新表空，重复建表幂等。
- 下游预演：`relation-migration-preview-01.json`；正式应用：`relation-migration-applied-01.json`。预演发现新表已存在且为空，不能写成“此前绝无迁移”；正式幂等迁移确认所需四列。
- 下游8张旧表原行数及摘要前后完全一致：5495地点、7808语料、270旧关系、24导入、42身份审计、201行程、8图片分配、1图片审计。新关系快照0行。这是batch26之后的本轮实测，不与独立图库首批前的旧摘要混用。

## 下一步

先收齐安装后跨语言联测与最后类型检查，核实实际安装哈希和新表状态；再为实际城市建立独立的关系同步预演/应用目录，避免混用实体batch编号。以真实导出、已有目录差异、正式关系消费及旧数据撤回为依据推进全城同步。王府井边界和其余混合分店/路段继续补证，不把安全排除或缺证据记作已归一。

## 济南实际来源预演发现的入口边界（后续进展）

安装后的下游联测`downstream-place_identity_test_1791360689834.log`、全仓与扩大类型检查均通过；安装后哈希预演50文件0变化。

随后创建独立`relation-sync/run-01`，仅在上游发布济南来源revision1并导出230地点/26关系（13direct）；下游知识238地点/340语料被冻结，尚未导入。逐篇核对发现“**大明湖北门→超然楼**”及“**五龙潭南门出来就是趵突泉**”将未注册入口表层借给母项，遂将run-01标为`superseded_not_imported`，禁止消费这组文件并保留复现。

新增入口/出入口/游客中心等明确设施限定的词面障碍，仅用于阻止误借，不生成实体、不授予别名。完整已确认同义名仍可绑定原短名提及；独立子项不能借给母项。`relation-facility-reproduction-01.log`保存13项失败（12个首尾设施反例和1个完整确认别名反例）；`relation-facility-fixed-01.log`46核心测试通过。此修复当前暂存，仅两文件变化，待全量回归后再次哈希安装并生成全新的run-02，不覆盖run-01。完整关系摘要变化将推进发布revision，不能复用旧文件。

## 设施修复已安装，济南run-02已正式应用

- 最终完整上游`upstream-full-place_identity_test_1791361502505.log`为467项通过；`upstream-install-relations-facility-20261007.json`已哈希安装2文件。安装后跨语言联测`downstream-place_identity_test_1791360689834.log`、全仓与扩大脚本typecheck已通过，没有遗留待收取句柄。
- 最新只读报告`mention-relations-audit-1791361794110299400/report.json`为10城788关系/231direct，受控关系0。它不等于实城同步或身份验收；此前888/232为修复前结果。
- 济南`relation-sync/run-02`冻结230地点/26关系/13direct，来源revision2。两篇设施表层不再作为母项证据，13条强边均仍有其他原文支持。专用库预演日志`downstream-place_identity_test_1791361726171.log`：230实体ID、13强关系、238旧行与图片字段保留、两次倒序审计恢复一致。
- `apply-relation-city.mjs`核验当前上下游与冻结一致后执行正式双导入，两步分别留日志和状态。地点审计`e587d4e6-5c37-486b-b1f1-58271cf1ff4e`，关系审计`24d44e44-079c-4f22-946e-edb423380e76`。run-02已完成，不可重放；run-01保持`superseded_not_imported`。
- 新`check-relation-city.mts`仅用独立pg只读事务核验：238旧行保留，254名称及476历史ID解析、26完整图/13可用强边、独立图片分配与201行程摘要均通过。230可用地点的向量及embeddedText均当前有效，无需调用回填。济南没有旧图片字段，本城的0项检查不能代表北京等图库已验证。
- 首次实库核验探针错误地要求上游identity与下游identity逐字段相等，遇到正式导入派生`nameKeys`失败；改为排除该派生字段后验证上游声明，未改产品或实库。扩大脚本类型检查已通过。
- `prepare-relation-city.mjs`使用全新独立run目录按真实双导出→当前知识冻结→专用库正式双导入与倒序回滚准备下一城市，未决进程不重放。接着逐城审阅原文、正式应用和实库核验，不把关系机制完成当作138实体对/4提及已解决。

## 多段路线误连修复与第二轮来源发布

云南run-03、西安run-04、广州run-05、成都run-06已正式双导入并完成名称/旧ID/图片/行程只读核验。上海run-07预演虽通过SQL契约，逐篇审阅仍发现2474“田子坊→思南公guan→新天地”和2508“豫园→taste of china味餐厅→外滩”跨过未抽取中间节点；run-07现为`superseded_not_imported`，从未导入。

新规则拒绝两端之间多个路线箭头的证据，记录`unbound_route_segment`；不猜测中间文字是地名还是交通描述。因此多箭头交通说明也会保守排除，单箭头说明仍可用。`sourceState.algorithmVersion`推进为2，下游接受已知1/2用于历史兼容，未知版本拒绝。来源Hash必变，已同步城市须用新目录、新revision重新预演和发布，不能覆盖旧记录或重放实体批次。

- 复现`relation-route-reproduction-01.log`：11失败/46通过；修复`relation-route-fixed-01.log`：57通过。
- 完整上游`upstream-full-place_identity_test_1791362993968.log`：478通过；下游`downstream-place_identity_test_1791362989925.log`：26通过，含算法1→2双导入与倒序审计。全仓及扩大typecheck通过。
- `upstream-install-relations-route-20261007.json`保存3文件哈希安装结果，无新迁移。
- 最新只读`mention-relations-audit-1791362994282454500/report.json`：10城753关系/223direct、64个未绑定中间段，受控关系0。此前788/231是上一算法结果。
- 成都run-08已更新revision2：50完整关系/15direct；镗钯街—熊猫书店因一篇多箭头交通描述被保守排除而降weak。上海run-09已正式同步revision2：61完整关系/22direct。两城名称/旧ID/图片字段、成都两条撤回、201行程摘要通过。
- 实库核验发现成都6行、上海2行已有向量但没有`embeddedText`来源记录，冻结前即存在。不能声称这8个向量已证明当前，也不能靠仅补NULL的现有backfill命令修复；待独立保留审计的向量刷新。其余已核验城市无此缺口。

后续按新算法继续杭州、重庆、北京、厦门，再更新已发布算法1的济南、云南、西安、广州。全部实城同步后刷新flow/audit；138实体对/4提及补证仍未完成。
