# 逐提及事实字段排除设计

首例是原文2837的四处合计30分钟，不应给王府池子、腾蛟泉、起凤泉、刘氏泉各赋30分钟。复用完整scope决定、实体版本和回滚；不改PlaceMention/RawNote，不合并或撤回已知独立主体。

## 契约

`assignments[].factExclusions`可选，首版只允许：

```json
{"visit_duration":{"reason":"group_duration","quote":"四处地点及合计时间的当前原文摘录"}}
```

持久化为`place_mention_assignment.fact_exclusions JSONB NULL`。绑定现有inputHash（含原提及、原文、图片分析）和明确非空entityId；必须有visit_duration分钟值，摘录须出现在当前可用标题/正文且包含当前提及原名/规范名。不允许任意字段、理由、空对象、替代分钟值或与非地点排除混用。语义决定来自逐项原文核查，校验器不以关键词自动推断四处组合。

合法排除仍解析为resolved，返回可消费字段策略；只从事实投影去除minutes，保留原始row和指纹。描述、统计、关系来源及主体继续可用。源或提及变化进入原有review分支；非法持久化策略也进入review，不退回旧值。新提及仍须完整scope审核。

## 路径

- `apply_scope_decision`校验并持久化；snapshot可空时省略新键，兼容旧审计；倒序回滚恢复字段决定。
- `summary.mention_groups`及`scoped_facts`共享事实投影；普通地点进入scope后，真实导出走受控事实路径，不继承canonical旧时长。QA与无主源实体导出均传入现行提及目录。
- 老`build_visit_duration`已有受控主体保护，继续不得以整篇挖掘写回。原始canonical派生缓存不直接修库；正式导出以审核后事实为准，后续sync仅按当前有效提及重建。
- 下游沿现有mentionSources权威替换契约清空旧typicalVisitMinutes；需实际导入和排程事实读取验证，不只看JSON缺字段。四主体和有效提及数保留，起凤泉唯一来源仍resolved。
- 实际排程`buildDraft → visitWeight`使用地点类型/类别的相对分量，不消费`visitMinutes`建立分钟时间轴。此次修复清除事实库错误，并验证分量不变；不得把四个30分钟字段夸大为某条真实行程已增加90分钟。

## 验证

真实PG覆盖：四主体和一个仍有独立时长证据的对照；无新提及计数损失、无原文改写；非法/旧哈希/空目标拒绝；新提及/原文变化重新待审；幂等、撤销/恢复及倒序回滚；旧库加列保留历史快照。真实export验证旧聚合30不回流、其他有效时长保留、关系状态仍resolved。

实城应用前冻结新批次并完成完整源决定和预演；应用后地点/关系双同步，验证SQL/向量/旧ID/图片/历史行程。第36批已安装、迁移、应用及完整双同步，详见[执行记录](batch36-jinan-spring-duration-20261008.md)；四泉实际SQL和向量已验证，既有撤回甜沫儿的本轮向量请求超时仍单列复核，不能据本设计文档推断整体验收。
