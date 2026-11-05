# 第31批：济南明确非地点排除

云南不处理。本批4项菜品/品类、8条提及已正式排除并完成双同步。01-v2至31禁止重放；无batch32、无待同步步骤。完整九城任务仍在进行中，用户未验收，不提交归档。

## 实际处理

note2560《济南一日Citywalk🚶‍♀️‍➡️超详细逛吃》的美食列表只描述九转大肠、济南锅贴、甜沫儿、老济南烧烤的口味和品类，未提供具体门店；同文的草包包子、亮亮拉面等品牌没有一并排除。

- 四主体保持原ID，revision 1→2；8条原始提及与原源不改写，排除证据写独立assignment。
- `excluded/reviewed_non_place`与旧null的`review/unassigned_target`分开。新提及、正文或来源变化不得继承旧排除。
- 显式撤回行保留旧ID，候选为空、无地点事实/分数/图片/向量；原始餐饮知识仍保留。

## 实现与预演

- 暂存上游519项回归：`upstream-full-place_identity_test_1791391031745.log`。哈希安装51文件中6文件变化，旧安装清单保存在`upstream-install-before-non-place-exclusion.json`。
- 新增可空exclusion列：`non-place-exclusion-migration-1791391169383896300.json`；八治理表旧行摘要一致，原44分配均保持空排除，再运行无缺列。
- 实城基线`all-cities/batch-31-baseline.json`：242源/242实体/19审核，SHA256 `4d56f319dde37c90b13b70d840b2fb97a80bd004e9b043dd95616cad61afe243`。
- `batch-31-source.json`冻结四主体完整匹配来源/8提及/1原文/0图片，SHA256 `a9c00bf3bb22dc34cc4fa29d351d0165ff9f87eac43a7b3a7faa53cb73d1cdab`。
- `batch-31/scope-preview-1791391278633300900`重建真实原文，确认排除/0提及待审、实际导出、幂等、倒序回滚和原文原源不变。明确属于部分城市重建，不冒称全城预演。
- 正式事务预演与应用分别为`batch-31-preview.json`、`batch-31-applied.json`，4个scope决策，0实体合并。

## 跨端遗漏与修复

第一次下游冻结预演被关系来源声明校验拒绝，未执行导入。原因：新增解析状态会进入relationIdentity，原下游枚举未接受excluded。保留`batch-31/sync-01/preview-济南-failed-status-01/freeze.log`，没有重导出或重放治理。

`placeRelationIdentity`接受且严格校验`excluded/reviewed_non_place`配对及空entityId/revision，仍禁止该提及成为关系端点。26项下游回归包括真实双导入/回滚通过，日志`downstream-place_identity_test_1791391480408.log`；全仓typecheck通过。修复后`preview-济南`完成真实城市旧目录重建、双导入和倒序回滚，25关系/13强边均未变化。

## 正式验证

- `batch-31/sync-01/sync-state.json`：230行（226有效+4撤回），关系来源revision5，25完整关系/13强边；地点→关系→回填全部完成。
- `verification-vectors.json`：四个撤回名称实际SQL排除，四次真实向量均`used`且无撤回ID；派生向量与旧事实清空。scope-only批次普通alias/vectorProbes为0，不能将其误报成没有验证撤回。
- `pre-import-check.json`及`post-import-check-*.json`：238旧行全部保留，图片字段0、独立绑定0；201历史行程摘要保持`e01d67cbf42a62fc595f4ef052f99e75`。
- `batch-31-upstream-check.json`验证4scope/8排除，107原始源字段、662提及指纹（82篇原文）不变；不是用0实体决策冒充scope验证。
- `flow/run-33`：12城279正例、113独立/包含、45撤回，0失败，12未导出负例单列；`cleanup.json`确认临时库已删除。全库只读冻结用于隔离兼容回归，没有治理云南。
- `audit/run-29`仍180PENDING行＝139实体对行/138对＋41提及，图片0、结构异常0；四咖啡门店与37错城来源继续原待审。

## 继续工作

`cleaning-scope/current.json`仍指向固定scope06，原978主体不重排；济南`review-02.json`保留98项，其中4非地点有明确排除结论，94项继续核查，7项错点清空后仍待精确定位。不能称济南全部验收。

继续核查泉池/公园混合来源、超然楼/大明湖超然楼、宽厚里/宽厚里美食街及其他重点项，再推进其余八城。已额外保存`priority-cities/济南/geo-03.json`供下一批核实，尚未依据该文件创建batch32。
