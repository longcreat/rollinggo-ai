# 第41批：尚泉尚水茶馆前平台身份与细分类

第41批已应用并完成济南228地点、20关系双同步。原source5945/mention12653对应的推荐主体改为“尚泉尚水茶馆前平台”，保留稳定ID `2c8372d3a47dbcb68abd998af495436d`，实体revision2经完整scope升至3，再经修订升至4。图片比对继续暂缓，精确位置仍未知；本批只计部分治理，不增加完整自查数量。

## 正文依据与结果

原note2795全文写明：“第二个机位搜索‘尚泉尚水茶馆’……其前面平台即可拍摄湖面与楼阁全景”。茶馆是定位参照，前平台才是摄影主体。保留唯一有效提及、原reason/evidence和摄影看点；主名及同义名只保留平台名，裸茶馆名进入excludeNames。粗类别为自然、细分类为photo_spot；旧约39公里外的错误坐标已在第30批清空，本批继续保留null/unresolvable，不使用未核实茶馆POI替平台定点。

旧原始源、提及的cafe类型和旧派生缓存原样保留供追溯。导出的有效themes已为空，不继续消费旧“美食/夜景”派生主题。新主名新增旧哈希兼容成员不代表新建实体；原稳定ID不变。source与决定冻结于`all-cities/batch-41-{source,scope-decisions,decisions,export-expectations}.json`，源SHA256为`3057bcbe346a412949cda3ffad1845f96a2d52bb0060988a31d9e25b95fb695b`。

## 实现和验证

上游既有治理overrides增加受校验的可选xhsPlaceType，实体修订与独立创建共用校验器。仅支持当前抽取器七类，拒绝null、未知值和非字符串。既有导出器已经能把该字段覆盖进payload，无新迁移、无新下游协议。

- 安装器校验55文件，更新3个实现文件和1个测试文件；旧实现按哈希备份。暂存360项通过，安装后完整587项通过：`upstream-installed-place_identity_test_1791477882585.log`。
- 真实正文隔离预演：`all-cities/batch-41/scope-preview-1791477937038516500/report.json`。1源/1提及/1正文，实际导出类型、名称边界、旧ID、有效描述、幂等和倒序回滚全部通过，原源与提及保持。
- 正式事务预演及应用报告：`batch-41-preview.json`、`batch-41-applied.json`，各2步。**已应用批次不能重放。**初次从错误工作目录启动CLI未能导入app模块，在任何数据库操作前退出；随后从上游目录执行成功。
- `batch-41-upstream-check.json`：原107源、662提及、82篇正文指纹保持，1条新分配及实体最终revision4核对通过。
- `batch-41/sync-01/preview-济南/`：冻结完整城市库，通过真实地点/关系双导入和逆序审计回滚；20关系与9强边内容不变，来源快照revision15。
- `verification-vectors.json`：新平台名SQL首位和1次生产超时配置下真实向量请求成功，既有撤回检查通过，无向量待复核。
- `platform-consumption-1791478328214.json`：完整城市隔离导入前平台确实作为cafe进入food查询；导入后按photo_spot读取，food查询排除、正确平台名SQL召回、裸茶馆名即使带旧ID也不绑定。实际loadCityPlaceFacts→visitWeight得到1，placeCategory得到attraction。保留未知坐标，未声称自动地理排程已覆盖。成功日志`downstream-place_identity_test_1791478322812.log`。
- 专项首轮失败是新增验证直接比较上游identity与带派生nameKeys的下游identity。已按现有契约完整核对声明及派生索引，保留失败日志`downstream-place_identity_test_1791478253992.log`；未修改产品逻辑或删除身份断言。
- `priority-cities/济南/platform-downstream-check-01.json`：正式上下游只读核对228地点消费字段、16条分配、前序4描述字段排除和4时长排除、60待审提及，以及灵岩寺有效看点均通过。
- `post-import-check-1791478136108.json`：238旧行、48个既有图片字段（包含null）、9独立绑定保持；201历史行程摘要仍为`e01d67cbf42a62fc595f4ef052f99e75`。48是本次导入前实际存在的字段数，前批治理新增显式空字段不代表新增或比对图片。
- `flow/run-43`：12目录291正例/113独立或包含/47撤回，0失败，临时库已删除；`audit/run-39`：240PENDING、结构异常0。范围外城市仅参加只读冻结及隔离回归，无治理写入；不是完整产品E2E或用户验收。
- 全仓`npm run typecheck`与扩展验证脚本TypeScript检查通过。台账“部分scope”沿既有口径包含仍待分配的2个撤回混合源；记录脚本先核对实际行状态，未改变原入选范围或状态来满足统计。

## 续作

review20保留98原入选行：4非地点、19行AI自查（17主体）、75未完成，其中9行部分scope治理、其余66行继续。固定九城978主体＋56依赖/1135源、110范围内待审及4必去缺口不变。平台身份修订已解决，但原7待定位、两园区位置/类别、月下观棠墙面与店铺边界、VILLASHAKA与BLUEDUCK位置及桥/门洞等继续核查。

实体最新41、独立图片03、flow43/audit39；同步和向量验证已完成。图片暂不比对，用户未验收，任务保持in_progress，不提交或归档。后续新完整回归使用flow44/audit40。
