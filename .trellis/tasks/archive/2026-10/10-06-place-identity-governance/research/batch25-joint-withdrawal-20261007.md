# batch25联合撤回与裸名防复活

## 状态

batch25已正式应用，2scope+2uncertain说明更新；sync-01厦门617条、成都392条完成完整同步。禁止重放上游。同步暴露的撤回向量回填漏洞已修复，经正式导入清理和回填复核，最终实库核验0失败。全城消费flow/run-26通过，完整任务待用户验收，不提交归档。

## 证据与决定

四原始提及为厦门5461/6841、成都3533/3719；各城两个来源联合纳管。原文、已查看原图和评论不能确认具体分店，旧地图匹配不作为目标分店证据。全部显式null，4旧ID以withdrawal保留，候选为空，实体对203/305继续uncertain；0合并、0新分店、0图片。范围冻结joint-coffee-source-1791338728505852300.json。现行实体对138不减少，另增加4条mention_scope待审。

## 实现

- 同步城市取实体决策与scope决策并集；scope-only必须列明全部受影响实体导出预期，预期哈希冻结。省略撤回行、保留verified或旧提及拒绝同步；4项回归含batch24兼容通过。
- 新verify-withdrawals.mts单独验证所有撤回主体的名称/ID、SQL排除、候选拒绝、行程保存读回、旧版本保持及新编辑拒绝；全城消费报告新增withdrawalProbes，重导入防护也纳入撤回行。
- run-flow可在只读目录副本覆盖冻结预演导出，manifest明确plannedOnly；不冒充实城已变更。

## 产品缺陷与修复

真实实城冻结导入发现：无候选撤回解析为普通unresolved，add_candidate仍会沿模型补充回退把泛名重新入池。失败证据downstream-place_identity_test_1791339289248.log。现在PlaceResolution保留status兼容并加reason=withdrawn；候选和新增编辑明确拒绝，旧行程不改写。有裸名搜索坐标也不能解除待核实；普通未收录地点仍可走既有流程。完整26项相关测试通过：downstream-place_identity_test_1791339359204.log。

## 预演与验证

- 实城部分数据隔离重建all-cities/batch-25/joint-preview-1791339205261456800，2scope/4撤回/4提及待审/2实体对待审，幂等与倒序回滚通过，原始提及未变。日志upstream-stage-place_identity_test_1791339202983.log。
- batch-25-live-preview.json：实库同事务预演后rollback，2scope+2uncertain说明更新，四实体revision2；全目录仍138对。
- flow/run-25为plannedOnly隔离覆盖：243正例、113独立包含、4撤回、12未导出负例，failures=[]，临时库已清理。不能称门店定位已解决或全产品E2E。
- 全仓typecheck已通过。扩大专用tsconfig后发现旧flow探针payload可null而ImportPlace只接undefined，已明确转换；专项检查通过。新测试坐标缺adcode的编译错误已补字段，不是产品问题。

## 验收边界

继续保留138对缺证据关系；全null不证明合并或独立。未提供新的分店创建审计、独立图库逐图绑定或逐提及关系挖掘；现有禁止受控主体裸名借图和借关系的防护继续生效。用户验收前不提交、不归档、不标记任务完成。


## 实库应用与最终验证

- batch-25-applied.json为apply=true/4变更，仍138实体对；scope4/联合成员4/assignment7。四来源和原始提及未改，实体revision均2，203/305仍PENDING uncertain。证据all-cities/batch-25/source-verification.json，最新只读冻结joint-coffee-source-1791339935835431300.json。
- sync-01导出与导入厦门617/成都392，包含各2条撤回行；不是删掉旧ID。最终两城可用主实体615/396，向量覆盖615/615与396/396。普通旧照片检查6/4条通过，本批撤回主体匹配图片0。
- 首次verification-vectors.json保留4项withdrawal_vector_retained失败：回填器只排重定向，重新嵌入verified=false的撤回行；四次真实向量检索当时已正常排除旧ID，不能以此忽略存储违规。
- embeddingBackfillIdentity.test.ts先失败复现（downstream-place_identity_test_1791340044174.log），再通过真实脚本/本地模拟向量服务覆盖读取和写回资格。最终通过日志downstream-place_identity_test_1791340277497.log；中间通过1791340085292也保留。
- 修复器repair-batch25-embedding.mjs用原冻结文件经正式导入创建新审计并清四向量，再执行修复后回填，两城均无待回填。embedding-repair-01.json与repair-01日志留证；没有改写sync状态或重放上游。最终verification-vectors-repaired-01.json四次真实向量查询used、旧ID不召回，字段/旧引用/向量/照片0失败。
- 实城全目录flow/run-26：12城243正例、113独立包含持久化、4撤回探针，failures=[]，临时库清理完成。12个未导出负例单列未覆盖，不称全产品E2E。run-26的身份快照不含向量；后续仅派生向量清理不改变其身份输入，因此不重复全链回归。
- audit/run-23：143 PENDING行=139实体对行（138对，1历史重复）+4提及行；实体对全uncertain/未审0，提及审核行尚无assessment字段而单列unassessedMentions=4，不能声称所有审核队列未审0。图片0、异常0。
- 最终新增编辑/裸名等16项回归通过（downstream-place_identity_test_1791339803761.log），全仓typecheck通过；研究脚本及embed-backfill扩展专项typecheck通过。回填脚本原有索引类型错误已用泛型查询行与明确输入快照修正，去除payload双重断言。

## Bug Analysis: 撤回状态在后续消费中丢失

### 1. 根因

B跨层契约及C传播遗漏：无候选撤回与普通未收录均返回unresolved，候选入口误走外部/模型回退；离线回填沿用只排重定向的旧资格条件，导入清理后又写向量。

### 2. 为什么早期验证没发现

合成导入测试已查清向量，但未继续执行实际回填命令；原全城探针只遍历verified根。联合预演新增裸名/编辑探针揭示第一个缺口，实库完整同步后的只读存储检查揭示第二个。两次均为产品缺陷，不是探针误报。

### 3. 预防机制

显式reason=withdrawn贯穿新增消费，保留历史；回填读取与写入均检查资格。官方回归覆盖并发资格变化；全城撤回独立计数、真实向量和存储状态分别校验。

### 4. 同类边界

受控主体裸名照片/关系回退继续禁止。恢复必须高版本且有当前可用提及；不为消除待审随意选分店。现有历史行程只在隔离数据库验证保存/编辑，未读写应用用户行程。

### 5. 知识记录

place-identity.md第12、15、16节已更新。没有提交、归档或标记完成。
