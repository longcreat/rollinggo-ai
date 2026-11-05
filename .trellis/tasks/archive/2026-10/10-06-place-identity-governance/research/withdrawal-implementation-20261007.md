# 撤回闭环与batch-24续作记录

## 当前状态

已安装逐提及/逐图/撤回上游补丁，并创建三张治理表。batch-24已正式应用和完成重庆同步，**禁止重放**。用户未验收，Goal仍active，不提交、不归档、不标记完成、不push。

## 本轮实现

- 上游受控实体没有可用提及时显式导出withdrawal；来源隐藏、提及证据变化、移空旧分店都不会留下隐式活跃行。候选只来自被撤回实体自有scope。
- 下游严格验证撤回、版本、空事实/图片、最终目录中的候选有效性。旧版本不可恢复，恢复必须有更高revision与可用提及。金集清旧事实、封面、图库、amapPhoto和向量。
- 旧ID/旧泛名有候选即ambiguous（单候选仍一样），无候选unresolved；两家新实体仍可分别选用。真实历史行程保存/读回/编辑验证不偷偷替换为某分店。
- 关系消费不使用受控端点的裸名关系；关系导入只清它们的旧边，空数组仍清理并审计，缺列表拒绝；普通关系保留。审计快照增加可选relations/relationImports；旧批次无这些字段则按原范围回滚。
- 独立人工图库/模型审核图库对受控主体停止裸名补位，输入名称及实际命中的目录主体都检查，括注回退不能绕过。受控主体仍使用逐图绑定的库内图库。尚未给独立图库实现逐图稳定身份声明，也尚未实现逐提及关系挖掘。
- --purge拒绝删除已治理xhs身份；安装预览写独立文件，不再覆盖上次应用哈希记录；安装保存每个被替换文件的版本备份。

## 验证与安装

- 上游完整362 passed：`upstream-full-place_identity_test_1791334571364.log`。
- 下游相关69 passed：`downstream-place_identity_test_1791334845149.log`。旧placeFacts/relations部分用例无种子时提前返回；本轮新增真实脚本/SQL/向量/行程测试有独立合成数据，不把前者算作实城集成验证。
- 全仓typecheck通过，相关diff-check通过（仅换行提示）。
- 暂存模块重建01-v2、02、03、04、05-v2、06至23，23/23幂等和倒序回滚通过：`scope-batch-regression-1791334989518.json`。只使用一次性库，没有重放实库或覆盖原批次预演报告。
- 安装预览38文件/30变化且无并发冲突；正式安装成功，`upstream-install.json`保存应用哈希，逐版本备份在`upstream-install-backups/`。
- 三张表place_identity_scope/place_mention_assignment/place_image_assignment创建成功，第二次执行missing为空：`scope-migration-apply-20261007.log`、`scope-migration-rerun-20261007.log`。

## 459 / batch-24

- 冻结现行来源：`scope-source-459-1791335308979279800.json`。source176/215，mentions534/1119/1615全部来自note7，三条原证据都是“呼归石公交站对面”；普通和精选相关图片均0。更早一次冻结没有精选目录与审核fingerprint，保留但未作为正式请求来源。
- 两条scope完整覆盖三提及，均指向`2f6c627fdf341bf54b049f3c0ae84d74`；随后纠正错抽取旧实体`79afbf6edf8899c29d2eb71edf8c3c81`并excludeNames=[呼归石公交站]。主实体revision5，旧实体revision3；沿用原已核实的未知坐标，不借车站点。
- 隔离预演导出、幂等、倒序回滚、新真实公交站提及待审通过：`upstream-stage-place_identity_test_1791335425565.log`、`all-cities/batch-24/scope-preview/report.json`。
- 实际上游导出→真实下游脚本→检索/事实/旧ID/独立选图门禁/行程保存读回及编辑通过：`downstream-place_identity_test_1791335559451.log`。第一轮验证文件用.ts导致ESM顶层await加载失败，改.mts后通过；原失败日志`downstream-place_identity_test_1791335543832.log`保留。
- 实库事务预演3变更成功，随后正式应用3变更（2scope+1纠错），`all-cities/batch-24-applied.json`。**已应用，不可重放**。
- `batch-24/sync-01`重庆完整567条export→import→embed。上一重庆batch-17为568条，本次目录仅减少错抽取旧实体1条，其他ID/名称无差异。回填命令无待回填行；随后真实向量查询单独验证通过。
- 实际库1名称/1真实向量、字段、旧ID和排除错名0失败；581活跃根/581有效向量，照片核验0。导入审计`c8cf0e04-2067-4c1d-9f16-0ef3fd12a3d2`。
- `scope-applied-verification.json`确认两scope、三assignment，原始提及hash与源名称未变，459为RESOLVED，公交站裸名仍不解析为机位。

## 全城现状和下一步

- `flow/run-24`：243正例、113独立/包含实际持久化、12未导出负例；重庆34正例0失败。仍仅厦门CUIDA、成都MONDOLI两组4条目录别名歧义；防护通过但总进程按未解决问题退出1。临时库已清理，不能称全绿或全产品E2E。
- `audit/run-20`：139 PENDING行/138现行实体对，全部uncertain、未审0，西安1条历史重复；无非法根和同根悬挂。
- 继续混合分店/路段的逐项补证与分配，特别是CUIDA/MONDOLI。138对缺证据不能为归零强并。
- 将来新scope产生mention_scope/image_scope队列时，旧audit-live的“所有PENDING都是实体对”假设需先扩展；本批无新未分配提及和图片，因此没有触发该队列。不得直接把这些非实体对待审记作非法根。
- 当前无运行中session、无待审批、无待同步步骤。用户尚未验收，不触发提交或归档。
