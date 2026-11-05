# 第51批：六家餐饮店原文地址与无依据坐标

本批六项决定已应用并完成上下游同步，不可重放。九城冻结978主体＋56依赖/1135源保持，云南不扩入主动清洗。未查看或比对图片；用户尚未验收，任务和goal仍进行中，不提交、归档或标记完成。

## 已生效结果

完整note2585逐店列出地址。每店两条重复提及，共12提及、仅1篇独立原文；六个独立主体均revision1→2，原名、别名、ID、美食/food和有效事实保持。消费坐标清空、geoStatus为unresolvable，原始来源坐标不改写。没有合并、新实体、撤回、scope、分配改动或待审增量。

| 主体 | 原源 | 提及 | 文字地址 |
| --- | ---: | --- | --- |
| 李山记铁板炒鸡 | 5332 | 11354、12595 | 县西巷86号 |
| 新秀炸鸡 | 5336 | 11358、12599 | 老商埠5号楼109 |
| 乐乎哉刘家菜 | 5337 | 11359、12600 | 经二路398号 |
| 凉皮嫂子 | 5338 | 11360、12601 | 铜元局前街 |
| 邻家羊肉面饸饹面 | 5341 | 11363、12604 | 经二路253号 |
| 杨氏泉水茶汤 | 5344 | 11366、12607 | 辘轳把子街12号 |

旧点距原文街区的粗略参照分别63.33、21.60、14.14、5.81、34.22、8.53km。参照不是门店点、道路边界或自动拒绝距离阈值，未导入任何参照坐标。六行均保留精确位置待核及媒体暂缓，不能计作完整自查或部分scope完成。

## 证据边界

源包`food-address-source-packet-01.json` SHA256为`23bc32bd7e3707dd1aff3c0eaa942e833c878ec8afc305429cf797c9b06882c7`；批次源`batch-51-source.json`为`b09a52110ec2d34818fe494c2042a707e6d3ef2571356a6d7a74db3992204793`。

`food-address-geo-01.json`有51返回行：50不匹配POI＋1无结果，matched仅指候选返回。geo02的无锡同名新秀炸鸡明确拒绝，其他5项未命中。街道查询因429失败，旧工具未保存该轮部分响应，不能声称街道无匹配。smart-search两次60秒超时，zhipu未配置；没有采用任何抓取网页。地址依据为已保存完整原文。

地图旧探针的异常曾把请求凭据带入终端输出。已修复`probe-shangbu-geo.py`：仅输出异常类型/状态、逐次保存部分结果，且在联网前检查`map-credential-rotation-required.json`。离线安全测试2项通过，使用假凭据；没有轮换凭据，天地图联网继续暂停，不能换脚本绕过。此限制来自[smart-search-cli技能](C:/Users/Aimer/.codex/skills/smart-search-cli/SKILL.md)的“Treat key rotation as a hard safety gate when previous key values were pasted into chat or logs.”，与用户的图片比对暂缓分别记录。本批其余验证无天地图网络请求。

## 验证

- 六源/12提及/1全文的真实隔离SQL、重复应用、导出与倒序回滚通过：`all-cities/batch-51/identity-preview-1791490489195664000/report.json`。正式CLI预演/应用各6步；107原源、662提及和82篇完整原文保持，所有目标终态revision2正确。
- 228地点/18关系/direct3双导出、真实双导入及倒序回滚预演、实库双同步通过，来源revision25。关系内容与证据0变化。导出SHA256 `2301de8d0cb21cbed7721ecf0cb8abbc9550c8c258de0180fadf0852761389b1`；关系SHA256 `a1aa8edd705ca5955bcc2929298fac35b77d57f943bde7b1e7d3b4f5984455c9`。
- `food-address-downstream-check-01.json`核验全部228导出行，268既有分配、107待审、全部review/scope/scopeSource保持。12次SQL调用及144次名称/旧ID边界检查通过（主名和相同已有别名重复覆盖，实际6个独立店名）；6家实际向量检索均used。回填命令确认无待回填行，232既有向量及输入文本全部保持。
- 元数据01后的旧看点日期稳定，observedAt差异0；content仅compiledAt随导出更新。524语料内容保持，505条fetched_at按正式导入时间刷新，并与审计after_state逐项相等。
- `food-address-consumption-1791490571712.json`实际调用placeFacts：六家均保留food/美食、2提及及原事实，无坐标。六目标旧/新均无图；mock补图回调前后各6次、真实入队0。老商埠3图摘要`2c29d7b93a412f38eb21d6ce3ece4f175e0576dee87bee3a179d5bb095868603`、经三路1图摘要`2143dbc77997beeaf461e337c7f018783583096ae8e60dac777fba41cdbefddd`保持。
- 238旧行、90图片字段、9独立绑定和201历史行程保全；行程摘要`e01d67cbf42a62fc595f4ef052f99e75`。flow53为309正例/113边界/47撤回、0失败，临时库已删除；audit50为287PENDING、0结构错误。全仓及扩展typecheck通过。
- 本批没有生产代码安装；已有61文件安装清单及暂存/实装哈希保持。元数据01的668全套测试没有在本批重跑，不冒用旧计数。

## 前置检查执行失误与补证

`check-batch-state.mts`要求`before <batch>`，本次误传`<batch> before`，检查立即拒绝；编排未检查退出码，仍继续正式导入。未生成`pre-import-check.json`，不能事后假写前置成功。

`import-audit-baseline.json`事后核对正式导入事务保存的before_state：5个整城表和地点/关系导入记录与预演冻结库完全相同；审计范围外的图片导入记录另与实库现状比较保持。历史行程以元数据01既有摘要核对，非倒填本批前置读数。补证记录preflightSucceeded=false；事后检查显式使用`--audit-baseline`。

补证探针初次把所有data_import记录误当审计边界，随后按真实captureIdentityImport契约区分两类导入记录，额外核验图片导入行；未改生产数据来通过断言。扩展typecheck发现语料Map推断unknown，补齐类型后通过。`sync-batch.mjs`已增加新导入前置成功工件门禁，后续漏跑或参数错误会在写库前停止；`sync-contract.test.mjs`六项通过，覆盖缺失、失败、错误城市、过期日期及事后补证冒充前置的拒绝边界。登记脚本初次遇原待审行无evidenceFiles，在任何落盘前拒绝，兼容该可选字段后单次登记成功；原行其他字段保持。最终任务上下文校验36个implement/35个check条目通过。

## 当前进度

登记后实体51/元数据01/图片03，review31、flow53/audit50，下一实体批次52、flow54/audit51。六行状态为reviewed_identity_media_location_pending；已清坏点待定位10→16、身份已查但位置/媒体待核3→9。98原入选行保持：4非地点、18行AI自查对应16主体、76未完成（22部分scope、54其余）。107提及待审、157正式范围审核及4必去缺口不变；两商业文字发现未应用，日期元数据未解决数0。地图凭据轮换及图片比对均保持当前限制，不阻止其他文字清洗。
