# 同名键来源防护与分类型审计

## 当前状态

本轮未创建或应用batch-25。已应用批次仍到batch-24，禁止重放。新上游防护已安装，未改变实库实体、提及归属或下游目录。完整任务尚未验收，不提交、归档、标记完成或push。

## 咖啡/饮品来源补证

- 已读`all-cities/coffee-comments-03.json`，1001新增相关内容均非原作者门店说明，主要为“点点”的泛化回答；不能用于给P10定位。1355唯一相关原作者回复为冰淇淋来自“轻松厨房”，与CUIDA无关。
- `coffee-comments-04.json`从03的游标续读，1001第7页7条、1355第7页1条，均无更多且没有新的相关线程。结合02的前三页、03的新页，1001扫描67条顶层评论，1005扫描40条、末次第5页为空，1355扫描61条。1507在01中扫描9条、第一页已无更多。不是把01和02重复页相加；回复子线程仅按目标名有限读取，不能宣称遍历了全部嵌套评论。
- 1005原作者“去源野店 那个好”仍只能支持小店与源野店的区分，尚未定位1001的门面。既有图片审阅结论不变，见`all-cities/chengdu-mondoli-image-review-20261007.md`。
- `all-cities/xiamen-cuida-360-fetch-20261007.json`正文为CUIDA、厦门思明区禾祥西路204-112号；`xiamen-cuida-trip-fetch-20261007.json`明确CUIDA（禾祥西路店）及相同地址。两份正文只证明门店档案，未将1355/1507提及对应到此店。
- `xiamen-cuida-address-search-20261007.json`主搜索生成的“2025搬迁”、便利店/超市说法没有primary_sources支撑，且与实际餐饮页面不符，全部弃用。不能以其证明厦禾路店搬到禾祥西路，也不能反推两实体可合并。
- `read-note-comments.py`保留断点续读，并将报告字段改为`maxNewPagesPerNote`、`maxTraversalPagesPerNote`，明确新内容最多3页、旧游标遍历最多6页。旧证据不改写。

## 审计修复

`all-cities/audit-live.mjs`此前假设任何PENDING都有两条entityIds，新scope的未分配提及、未核实图片会被误报为同根。现提取`audit-reviews.mjs`，分别处理entity_pair、mention_scope、image_scope。

- 实体对保留原有`pendingPairs / assessedUncertainPairs / unassessedPairs / duplicatePendingRows`语义，继续检查非法根、跨城链、环与未解决的同根。
- 提及按`mentionId + inputHash`统计，图片按`imageKey + inputHash`统计；不同证据版本不互相抵消。新统计字段分别为`pendingMentions / pendingImages`及对应待审行、uncertain、未审、重复行计数。
- 当前PENDING提及引用的scope必须存在且同城。缺字段/非法格式列为显式失败和`invalidPendingRows`，不能悄悄跳过；缺失图片是合法待审原因，不要求图片还在图库才能计数。
- 5项回归通过，包含三类混合队列、历史证据版本、错误根/环、非法输入和run-20实城快照逐字段对照。真实只读`audit/run-21`仍为139 PENDING行/138对，全部uncertain、未审0；提及/图片待审均0，非法行0，西安1条历史重复。`failures=[]`仅说明台账结构正常，不等于138对已经解决。

## 单源scope遗漏同名键旧实体的漏洞

`apply_scope_decision`按name_key收集全部匹配提及，但单源scope只保存一个源的指纹、版本和来源归属。若CUIDA/cuida属于两个旧实体，给其中一个源创建scope并把两条提及都设为null，旧实现会成功；`managed_entity_ids`只包含该源实体，另一个仍不受控，可能继续按旧缓存导出。第二条scope又被名称重叠检查拒绝，不能拿顺序执行当联合治理。

先加入大小写及全角两个隔离SQL反例，均复现缺少拒绝：`upstream-stage-place_identity_test_1791336867809.log`，2 failed / 135 passed。

已修复：在任何scope或assignment写入前，扫描本城`CanonicalPlace.name / normalized_name`的匹配键；另一个匹配源若未注册或属于不同现行根，拒绝单源请求。已通过正式同义决策归于同根的多个源仍允许，原实体边界保持不变。不能用本防护当作联合治理已实现。

## 验证、安装与历史批次保护

- 新测试扩展为4项：大小写/全角各覆盖未确认的不同根拒绝、已经确认同根允许。首次完整测试的两个失败是新断言误将全测试数据库的assignment总数要求为0，其他测试留有各自合法数据；修正为当前来源范围后再完整运行。失败保留于`upstream-full-place_identity_test_1791336913545.log`，未掩盖或清除其他测试数据。
- 最终完整上游366 passed：`upstream-full-place_identity_test_1791336962803.log`。
- 哈希安装器核对38文件，只变化`app/aggregate/mention_identity.py`和`tests/test_mention_identity_db.py`，无并发冲突；已安装，并保存逐版本代码备份。当前安装清单另冻结为`upstream-install-guard-20261007.json`。
- 安装后重新用batch-24冻结证据在一次性数据库重建，两scope、三提及、一纠错的幂等、导出、真实公交站新提及待审及倒序回滚全部通过。新证据在`all-cities/batch-24/scope-preview-1791337092229042800/`，日志`upstream-stage-place_identity_test_1791337089693.log`。runner退出0并完成专用库清理；没有重放应用数据库。
- `preview-scope-459.py`改为每次唯一输出目录，保留原`scope-preview`验收证据。全仓`npm run typecheck`退出0。

## 下一步所需的联合来源设计（尚未实现）

1. 一个治理范围必须显式包含所有同名键的旧源ID及各自指纹，不能只把它们列成目标实体来隐式覆盖。匹配源集合需在城市锁内校验；新增同名源不能无声改变已审核范围。
2. 引入版本化的范围成员，兼容已存在的单源scope、旧请求幂等和旧审计回滚。源ID只可属于一个范围；名称键、提及也不能被不同范围抢占。不能删现有两条459 scope或改写其历史审计以迁就新表形。
3. 整组所有旧实体、历史目标、派生缓存和图片都持续受控，实体版本一起校验/递增。每个被撤回旧ID只能获得本组有证据且仍可用的候选；没有证据的提及继续null，不能为恢复检索强选分店。
4. 新分店/路段需有明确原始证据和稳定ID创建审计；当前泛名旧实体不能简单改名占据任一分店。北京方砖厂654混雍和宫、南锣和无店址提及；西安5627还有11752端履门与12319钟楼店，不能只据新增一条括号就整源改名。
5. 先验证大小写两源、来源集合变化、证据变化、跨组占用、空目标撤回、逐图归属、上下游旧ID兼容与真实行程保存读回，再形成新的实城批次。当前四个咖啡/饮品提及的具体分店证据仍不足。

独立人工/模型图库逐图绑定、逐提及关系挖掘仍未实现；此前受控主体禁止裸名补位和旧关系消费的保护继续有效。
