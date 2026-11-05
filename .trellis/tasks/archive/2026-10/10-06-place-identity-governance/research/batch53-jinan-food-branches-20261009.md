# 第53批：恢复两家餐饮原始分店名

本批已完成上游治理、全城双同步和AI验证，用户尚未验收。没有提交、归档或标记任务完成，没有查看或比对图片。九城范围保持978主体＋56依赖/1135来源，云南不主动清洗。

| 原主体 | 当前名称 | 稳定ID | 确认/待审 |
| --- | --- | --- | --- |
| 鑫龙火锅 | 鑫龙火锅（北园大街店） | cc3ebff96b9f814d82ef808324a42400 | 1 / 3 |
| 七九刘家烧烤 | 七九刘家烧烤(纬九路店) | 97c845bd4afbe220afe8545ed5030c95 | 2 / 0 |

两个名称都原样取自已有提及。完整阅读6条提及对应的6篇原文后，先分别应用完整scope，再恢复分店名，两实体均revision1→2→3。保留旧裸名、原ID、food/美食、原地址坐标；无新实体、合并或撤回，也未声称旧位置得到新验证。

鑫龙11709明确“但一定要吃北园大街店”；11708消费投诉、12846口味分歧、12890正向裸名推荐均没有分店证据，三者同样保留待审。其内容停止进入当前北园分店事实，原始评价不删改。七九11635与12886分别明确纬九路，保留虾酱馒头片、各种烤串及独立推荐，不将人均102当固定价格。鑫龙既有图片文字分析的门头OCR不稳定，本批未看图、未据OCR更改品牌。

## 验证

- 正式preview/apply均4项变更；实际隔离SQL验证2源/6提及/6全文、重复应用和逆序回滚、原输入与历史审核保持、未来新增提及不自动落入scope。
- 初次隔离断言将memberIds误写为完全不变，失败记录保留。既有改名实现合法增加新名称的legacy_id；修正测试为核对旧ID加新名称ID后，通过完整重测。没有放宽生产规则。
- 228地点/18关系/direct3，来源revision27；关系内容与证据0变化。正常`before batch-53`前置检查成功后才执行地点与关系导入；真实双导入回滚预演通过。
- 107原始源、662提及、82全文保持，旧272条分配不变，总278分配；济南待审提及109→112。4条SQL检索、18个名称/ID边界、2条真实向量检索通过，无待回填。
- 实际`loadCityPlaceFacts`验证新旧名称、有效内容及分类；批次外全部事实保持，仅允许content.compiledAt刷新，observedAt严格稳定。新scope恢复原结构化看点，来源日期取原始observed_at。
- 238旧地点行、93个既有图片字段、9条独立绑定、201行程（摘要e01d67cbf42a62fc595f4ef052f99e75）保持。这里93是本批导入前已有字段计数，比前批基线90多出的字段来自前批受控身份导入，不是本批增加图片。
- 老商埠实际3图与经三路实际1图及摘要保持。两店新旧名实际图库均null，mock补图2→0，真实入队0；只核元数据及返回对象，不看图片。
- flow55：312正例/113边界/47撤回，0失败；audit52：292 PENDING，济南112提及＋6实体对。全仓及扩展typecheck通过，61个实装文件哈希保持，无生产安装。

## 台账与下一步

current指向实体53/元数据01/图片03、review33/flow55/audit52。济南98固定行仍为4非地点、18行AI自查、76未完成（25部分scope、51其余）；正式范围审核162项，另4必去缺口。清坏点待定位16、身份已查但位置媒体待核9保持；完整自查新增0。

已保存[饮品线索](priority-cities/济南/beverage-followup-source-review-01.json)：喜茶与山耶云耶原提及均限定融汇老商埠分店，但现行地址/点位及门店与装置粒度仍需核实。本批只读记录，不创建scope或修改这两店。原有老商埠、经三路两项未应用文字发现继续保留。图片暂缓与天地图凭据轮换门禁保持，其他文字清洗可继续。

下一实体批次54，flow56/audit53；不得重放本批。未验收，不提交、不归档、不完成任务。

## 主要证据

- [原文复核](priority-cities/济南/food-branches-source-review-01.json)、[下游检查](priority-cities/济南/food-branches-downstream-check-01.json)
- [隔离SQL](all-cities/batch-53/scope-preview-1791491956939237400/report.json)、[实际消费](all-cities/batch-53/sync-01/food-branches-consumption-1791492100509.json)
- [双导入预演](all-cities/batch-53/sync-01/preview-济南/preview-1791491995525.json)、[导入前](all-cities/batch-53/sync-01/pre-import-check.json)、[导入后](all-cities/batch-53/sync-01/post-import-check-1791492023279.json)
- [原始资料保全](all-cities/batch-53-upstream-check.json)、[真实向量](all-cities/batch-53/sync-01/verification-vectors.json)、[同步状态](all-cities/batch-53/sync-01/sync-state.json)
- source SHA256：63f73a5c07c562769ed6413129bbabecdbade9ac7a569d6ae671d28280789392
- 地点导出 SHA256：dd923366fe5b767c3a0b1f9145c1674e901534b861279130466621ddb7cb747b
- 关系导出 SHA256：ed7dcdf7cda024f2287e0c5d5be14481ab5d6a4d7c6f0da8f2ba027392d8c31a
