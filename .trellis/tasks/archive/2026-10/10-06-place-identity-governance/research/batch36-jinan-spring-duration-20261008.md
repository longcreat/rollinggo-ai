# 第36批：四泉组合时长的字段级治理

第36批已正式应用并完成济南地点/关系双同步。四个独立主体保留，错误的单点30分钟已清除；类别及位置仍待完整自查。完整九城任务未验收，不提交或归档。实体01-v2至36、独立图片01至03禁止重放。

## 原文与决定

原文2837将王府池子、腾蛟泉、起凤泉、刘氏泉合计游玩时间写作0.5h，四条提及却分别抽为30分钟。本批完整审核4源/11提及/4篇原文，对12941至12944只排除visit_duration，不平分或替换时长。起凤泉唯一提及12943保留resolved及有效描述。其他7条中刘氏泉12692的“簪花少女”摄影主体未证实，null待审；10条确认提及保留，不把摄影语境判为非地点。

四实体revision1→2，独立ID、现有文化类别和坐标保持。王府池子“濯缨泉”的别名证据不用于认领趵突泉园内“濯缨池”。玛瑙泉不属于本批，继续核查。

## 能力与验证

`mention-fact-exclusion-design-20261008.md`定义完整scope中的factExclusions，仅允许visit_duration/group_duration及当前原文引用，绑定原始inputHash。已安装52文件中9处更新；实库新增可空fact_exclusions列，旧数据摘要不变且迁移幂等，应用记录`mention-fact-exclusions-migration-1791403818698220800.json`。无需重跑安装或迁移。

上游309测试通过（`upstream-stage-place_identity_test_1791403325673.log`），其中17项专项覆盖字段校验、消费投影、原文变化、真实导出和倒序回滚。跨端真实CLI合成测试通过（`downstream-place_identity_test_1791403688133.log`），保留独立45/75分钟证据并清旧金集30分钟，验证事实消费与排程分量不变。专项typecheck本轮再次通过，新增batch36边界探针也纳入检查。

原始提及和原文不修改。事实投影排除minutes，受控导出不读取原canonical旧30分钟缓存；下游mentionSources权威替换清旧typicalVisitMinutes。实际`buildDraft → visitWeight`按类型/类别分量排程，不能声称本次给真实路线减少90分钟。

## 执行证据

- `batch-36-baseline.json`：242实体/242源/78审核，SHA256 `f4e8391403aee0d5a3cc1d20b70762bd1eb8961840ba1965ebe9ba1f331c156a`。
- `batch-36-source.json`：SHA256 `a190876abe15758195d146c395a0313f1e6619b2c422b11eb18a9d39359face6`。
- `batch-36/scope-preview-1791418665241022500/report.json`：真实四源隔离预演，10确认/1待审，4字段排除、原始资料、幂等及倒序回滚通过。
- `batch-36-preview.json`为正式事务预演；`batch-36-applied.json`为正式应用，两者4步scope决定一致。不能重放。
- `batch-36-upstream-check.json`：107原源、662提及、82原文指纹保持；4scope、11分配、4个字段决定和最终revision2均核对通过。新探针首轮误读resolver的entityId抛KeyError，改为实际entity.entity_id后通过；这是研究探针字段名错误，没有重放治理或修改产品代码。
- `batch-36/sync-01/preview-济南/preview.log`：完整228地点、地点/关系双导入和倒序回滚通过，临时库由runner删除。
- 地点SHA256 `91250e61b7dfc6f7f655727af409ef41d3bedc66dfbcc3309bb639541d6641f8`；关系SHA256 `c8ceac67832a1dc9d504e07f5380a15a311391f0b49efa2ac5c1a6238b49327c`。关系revision10、20条关系/9条强边；只更新曲水亭街—王府池子的端点版本，没有关系新增、删除或强度变化。
- `sync-state.json`记录导入、关系导入、向量回填均已结束；回填发现无待补行。
- `boundary-check.json`：四个旧30分钟已清，10条有效描述/语料、稳定ID、旧ID及4名称SQL首位通过；原59待审和6既有撤回保持，12692在完整关系来源中为review/null。
- `sync-01/post-import-check-*.json`：238旧行、27个原图片字段、济南9独立分配和201历史行程保持；历史行程摘要`e01d67cbf42a62fc595f4ef052f99e75`。
- `spring-photo-sources-01.json/02.json`：本批前后实际12目录/123图扫描，四泉均无匹配图源，目录输入摘要保持；不是仅以数据库零绑定判断无图。

## 回归与尚存验证限制

`flow/run-38`覆盖12城287正例、113独立/包含与47撤回，0失败，cleanup确认专用库已删除。云南只参加兼容性只读冻结与隔离回归，没有治理写入。该链路不调用外部地图或模型，不称完整产品E2E。

`audit/run-34`为240PENDING，济南66＝6实体对＋60提及，结构异常0。本轮正式范围内50重点实体对＋60提及＝110待审，另4必去缺口；固定scope06的原始统计不变。

首轮`verification-vectors.json`中起凤泉与既有撤回“甜沫儿”向量不可用；`verification-vectors-qifeng-recheck.json`证明起凤泉成功，但甜沫儿和趵突泉请求不可用。其余三泉及趵突泉首轮均有真实向量成功证据。专门`withdrawal-vectors-recheck-01.json`记录两次TimeoutError约2513–2517ms，保持原生产2500ms超时，不延长超时或把SQL命中算作向量通过。**甜沫儿本轮真实向量撤回复核仍待完成**；已通过的SQL排除及隔离撤回链路不代替该项。

## 续作

登记review-13：98原清单保持，4非地点、11行AI自查（9主体）、83未完成；本批四泉属于部分治理，不能加到完整自查计数。部分scope治理由5行增为9行，其余未完成74行；玛瑙泉、原7待定位及教堂位置仍待核。

后续先补甜沫儿向量复核及四泉类别/位置、刘氏泉摄影主体证据，再继续其他济南重点地点和其余八城。下一新flow为run-39、audit为run-35。不重排名删原清单，不回写原文，不因已隔离而关闭缺证据待审。
