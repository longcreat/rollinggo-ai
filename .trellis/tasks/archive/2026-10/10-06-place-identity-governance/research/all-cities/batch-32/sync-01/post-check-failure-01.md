# 第一次应用后检查的探针错误

命令：`node --import tsx .trellis/tasks/10-06-place-identity-governance/research/all-cities/check-batch-state.mts after batch-32`

退出1：`AssertionError: 未认领旧行被更改：ef9937ce2185cc51d0870a6c8ce9feaa`。

旧探针只把evidence.legacyId识别为显式认领，却没有识别decision.mergeEntityIds，误将本批已声明合并的“大明湖超然楼”当作批次外旧行。SQL/真实向量检查、实际导入/倒序回滚预演已通过。

修复只对决策显式mergeEntityIds检查当前重定向和主实体memberIds，再排除“未认领旧行不变”断言；同时增加批次外identity/redirect不变断言。不会按当前行有redirect而全局豁免，也不重放数据批次。
