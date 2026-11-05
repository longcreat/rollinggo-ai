# 第70批：锦里范围、原评价与组合名称边界

第70批锦里已完成真实来源预演、正式应用及双同步：17提及16确认/主巷1待审，住宿片区2字段与含交通75分钟排除；3原评价逐字保全，7原负评、6旧观点语料、3有效看点日期保持，现18语料/10警示。细类attraction改market，文化粗类、原名/根ID/旧点保持；revision1→3，既有别名补登记兼容ID。受控v2组合仅用当前合同memberNames，不放宽名称排除门禁，不作主巷excludeNames；普通facts前后均无主巷，删除的是includeComponents检索入口。上游66文件中3变更、无迁移，752通过/1真实地图检查排除，暂存/已安装专项各2通过。392地点/49关系版本10双同步，2SQL/1真实向量/21普通边界和3子项边界通过；武侯祠原网页及全部消费保持。武侯祠—锦里因884/912/950各有两个同名位置，仅保留945关系证据，direct15→14。127源/490提及/86笔记原文日期分析保持，47旧分配加17为64；411旧行/130旧图片字段/201行程保持，130不代表新增3图。372主名实际图库返回全等、11处各1图，mock358→357、主巷额外mock1、真实队列0。全仓/扩展typecheck通过；flow72为339正例/113边界/52撤回零失败，audit69为314PENDING。成都review07仍0完整/113未完成（4部分scope、4位置部分、1类别部分、104其余），济南review45保持。184范围待审=50固定实体对＋济南133提及＋成都主巷1，原成都39提及按历史分类；4必去缺口、978＋56/1135固定范围不变。锦里发现已部分解决，主巷仍待审，另5项发现未应用。实体70/元数据01/图片03，无待同步验证；图片暂缓、地图凭据待轮换、未验收不提交归档。

## 可核对的变化

| 项目 | 治理前 | 治理后 |
| --- | --- | --- |
| 原主体名/稳定根ID | 锦里 / 8a433260acdd259716088f8009e0fbdc | 保持 |
| 有效提及 | 17 | 16，主巷3702单独待审 |
| 类别 | 文化 / attraction | 文化 / market |
| 看点 | 含住宿片区错误看点 | 保全3条有效看点及日期，排除1条住宿片区看点 |
| 原观点 | 7条负评、6条旧观点语料 | 全部保留，补3条完整原评价，现18语料/10警示 |
| 独立停留时长 | 无 | 仍无；4061含打车75分钟不能新增为独立时长 |
| 主巷入口 | 普通facts已无，includeComponents仍能借母项检索 | 三种子项名称/ID入口均退出；原名及提及保留待审 |
| 武侯祠—锦里关系 | 4篇证据，direct | 945一篇、weak；总关系仍49 |

[来源逐项审阅](priority-cities/成都/jinli-source-review-01.json)保持prepared历史状态；正式应用及最终结果以[本批核验](priority-cities/成都/jinli-final-verification-01.json)为准。3822住宿片区reason与evidence_text按subject_mismatch排除，4061按group_duration排除分钟，不删原文或作者意见。3条补充评价为910/image5、902/image5、948/image2整段原句；948保留编号、评分、换行及全部观点。936额外段落只保存在原分析，未剪成新警示，也未声称全文新增消费。

[组合名称设计](planning-excluded-names-design-20261009.md)对已有mentionSources的v2组合使用当前合同memberNames，未受控v2保留原行为并过滤已有排除名，v1保持。禁止假确认主巷、放宽validate_name_exclusions或借静态planning补回待审子项。此次未提交excludeNames、未新增实体、未改原名/根ID或坐标；现有锦里古街别名补登记合法兼容hash ID。

[关系原输入核对](priority-cities/成都/jinli-inputs-check-01.json)实测884/3961、912/4155、950/4209各有两个同名位置，按既有ambiguous_text_occurrence退出关系证据。观点语料均保留。武侯祠全部字段、旧web profile与未治理150分钟保持，不能把关系降级归因于主巷待审删三条边。

## 验证与保全

[真实2源43提及/28全文重建](all-cities/batch-70/scope-preview-1791512008187072400/report.json)、正式事务预演、[全城双导入预演](all-cities/batch-70/sync-01/preview-成都/preview-1791512338639.json)均通过，含幂等和逆序回滚。[全城导出](priority-cities/成都/jinli-export-check-01.json)392地点符合预期，391其他地点逐字段保持；[实库检查](priority-cities/成都/jinli-downstream-check-01.json)2SQL、1真实向量、21常规边界通过。[实际facts与图库消费](all-cities/batch-70/sync-01/jinli-consumption-1791515645917.json)另核3个includeComponents边界、372原主名图库实际返回，以及锦里两名称键预期的type/recommendScore/mentionCount/themes变化；其他facts保持。

[输入保全](priority-cities/成都/jinli-inputs-check-01.json)覆盖127原始及派生源、490提及、85旧笔记加补充948共86篇的原文、raw_json、日期与analysis空值形态；旧47分配加17为64。[同步后核验](all-cities/batch-70/sync-01/post-import-check-1791512691144.json)411旧行、130旧媒体字段、0独立绑定、201行程保持。130媒体字段包含前批茶社空字段，不能解释为新增照片。实际11处各1图返回全等，武侯祠/锦里facts和lookup无图，人民公园facts旧1图和封面保留、专用lookup仍空。mock358→357只停止锦里补图，未知主巷另计mock1，真实队列0；没有查看图片。

上游全套752通过/1真实地图项排除，暂存和已安装规划专项各2通过；安装清单66文件散列与上游逐一相同，本次3文件变更，无迁移。全仓typecheck会话47545、最终扩展typecheck会话6931均已退出0。[flow72](all-cities/flow/run-72/report.json)339正例/113边界/52撤回零失败，临时库已清理；[audit69](all-cities/audit/run-69/report.json)314PENDING，其中成都47=7实体对＋40提及。失败预演与验证日志保留：待审名不能排除、合成变体复用change_key、误以为普通facts曾含主巷；均修正方案或夹具后重新通过，未放松业务边界。

## 续作断点

当前实体70/flow72/audit69，成都review07、济南review45，无待同步项。下一实体71/flow73/audit70，成都下一review08；不得重放第70批、旧编号协议登记或应用导入。成都完整自查仍0；5项未应用发现包括原济南3项、人民公园和武侯祠，锦里主巷转正式待审而非完整解决。下一步优先处理武侯祠web profile审阅绑定与事实排除，现有profile保全机制尚未应用，不直接改缓存，也不把冲突网页口径拼为现行政策。978＋56/1135固定范围、4必去缺口及图片暂缓政策保持，未验收不提交归档。

来源SHA：21f57b6b992060060171b5f474872c968443148fc616e62ba79e155386b2c597。导出SHA：1aa2c7b74c7e64868511ec8f0a614857a52c11d38a5cd81a41cfe74058f3010f。关系SHA：b96811192f45ccbe6efddf38685777ba0cda2beaa66ecf74f9f83ef5715f01e9。
