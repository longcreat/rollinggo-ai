# 金集入口身份保护与遗留来源冻结

## 已实现与验证

`seed-canonical-places.ts`及`restore-goldset.ts`已改为共用`goldsetPlaceImport.ts`，保留默认eval快照入口，并支持指定快照目录和dry-run。每城事务、身份锁、地点行锁及前后审计统一执行；不改历史行程。

- seed不重建已被稳定实体、成员或重定向声明占用的ID；已确认、歧义或撤回名称不能新增。未知独立geocoded地点仍允许创建。
- restore合并保留现行身份、受控提及、图库、撤回及其他payload字段，仅恢复金集来源和活动溯源。已治理类别不回退，未治理类别变化时清过期向量及输入声明。
- 新增真实PG并发测试：图片更新持行锁时恢复等待，之后读到新图库，审计回滚同样保留图片更新；使用`pg_blocking_pids`确认实际等待。
- 幂等重跑不新增审计，dry-run回滚数据和审计；CLI原有启动迁移仍存在。

有效双失败复现保存在`downstream-place_identity_test_1791365690295.log`；更早`downstream-place_identity_test_1791365665571.log`的restore探针有JSON编码错误，不能当作产品失败证据。

修复后30项金集/审计/关系回归通过：`downstream-place_identity_test_1791365912047.log`。补并发测试后3项金集专项通过：`downstream-place_identity_test_1791366169828.log`。全仓及`tsconfig.verify-joint.json`扩展检查均退出0；后一次扩展检查包含新增来源冻结脚本，83611/57358句柄已收取结束。

继续自查发现缺可选向量列时restore会失败，已用真实PG事务模拟缺列复现：`downstream-place_identity_test_1791367161067.log`。按现有导入器检查`information_schema.columns`后再清向量；修复后7项金集/审计回归通过：`downstream-place_identity_test_1791367200116.log`。随后全仓56346与扩展66528类型检查均通过。

**没有在实库运行金集seed/restore，没有为57条旧行直接补向量声明。**

## 遗留记录证据

- 最新`retained-place-sources-1791366327590.json`冻结57行：35条xhs和22条金集，579条去重提及、251篇原文；22条金集均找到对应eval活动。包含原始名与normalized_name、当前候选身份、来源坐标及源快照哈希。
- `retained-place-sources-1791366256174.json`是第一次冻结，576提及；后来补齐“原始名→旧normalized_name→现行根”的候选追溯，不能把该旧归一结论本身当作同体证据。
- 相似名、去城市前缀和旧抽取归一只用于找候选。上海当代艺术博物馆/上海博物馆、餐厅/附近地标均不是合并对象。
- 已确认上游旧归一仍混有范围：西海湿地公园→什刹海、鼓楼+钟楼→钟楼、南锣鼓巷两侧胡同→南锣鼓巷、机位→入口等；这些需要逐提及/范围治理，不能直接补同义别名。
- 金集楼外楼孤山店的坐标远离杭州西湖，门框胡同卤煮的“前门”描述也与坐标不符。不能凭geocoded标签或一个同名地图点确认门店，需要另行核查。

## 当前执行

batch27已应用并同步14条证据明确的旧名/历史ID认领：北京12条、成都“成都墙”、重庆“洪崖洞民俗风貌区”。无上游实体合并，未处理以上分店/范围问题。

`batch-27-isolated-preview.json`及`upstream-stage-place_identity_test_1791366957939.log`证明隔离真实SQL幂等、倒序回滚通过；初始冻结缺的13个源已只读补充，历史依赖仅batch06/07。实库事务预演核对14个主ID/版本/名称/旧ID后，`batch-27-applied.json`已正式应用14项，禁止重放。

三城在`batch-27/sync-01`完成双导出及`preview-城市`专用库双导入、照片保留、关系消费和倒序审计回滚。北京关系138→141（新增3条weak），强关系仍36；成都49/15、重庆93/31保持。新增三边为1145的TIGER→五十六朵花→DULTON及604的北京历代帝王庙→广济寺，逐条核对原文，均不达到两篇强关系门槛。其余只有端点版本推进。

`relation-delta.json`最初用JSON键序比较误报全部关系变化，保留原文件；改用结构比较后的`relation-semantic-delta-01.json`才是有效差异报告。没有重跑或改写原预演。正式双导入、14条向量回填及29名称/14真实向量验证均通过；`pre-import-check.json`和`post-import-check-1791367623302.json`证明照片、独立图库、未认领行以及201条行程摘要保持。flow/run-30为12城257正例/113独立包含/4撤回+10城实际关系消费0失败，12未导出负例单列；audit/run-26仍138对/4提及，余43旧行需继续核查。完整结果见[batch27报告](batch27-retained-aliases-20261007.md)。

用户未验收；任务保持in_progress，不提交、不归档、不标记完成。
