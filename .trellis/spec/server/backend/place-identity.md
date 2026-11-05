# 地点稳定身份与治理

## 1. 范围与触发

地点导入、别名检索、候选池、排程、详情编辑、照片或关联对涉及地点判等时必须使用稳定身份。
名称相似不是实体相同；城市、分店括号、子景点和出入口都属于判断边界。

## 2. 入口与签名

- `lib/placeIdentity.ts:createPlaceIdentityIndex(rows)`：`resolve(city,name,id?,includeComponents?)` 返回 `resolved / ambiguous / unresolved`；`candidatesForReview` 只生成待核实候选。
- `services/placeIdentityService.ts:loadPlaceIdentityIndex(city)`：读取完整同城 verified 目录，不能用 top-k 搜索结果证明名称唯一。
- `services/placeImportIdentity.ts:prepareImportedPlaces` 在首次写入前校验；`reconcileImportedPlaces` 在同一事务应用主身份与重定向。
- `services/placeIdentityAudit.ts` 保存 `place_identity_imports` 前后快照；`scripts/rollback-place-identity.ts <auditId> [--apply]` 默认只预览。
- `scripts/embed-backfill.ts --tables places --city 济南` 按城市补向量；文本含主名和已确认别名，写回时核对输入快照。

## 3. 契约

```json
{
  "id": "持久实体ID",
  "name": "融汇老商埠",
  "payload": {
    "aliases": ["老商埠", "经三路老商埠"],
    "identity": {
      "version": 2,
      "entityId": "持久实体ID",
      "revision": 2,
      "canonicalName": "融汇老商埠",
      "kind": "same_entity",
      "memberNames": ["融汇老商埠", "老商埠", "经三路老商埠"],
      "memberIds": ["持久实体ID", "旧导出ID"]
    }
  }
}
```

`entityId` 必须等于导出 `id`；改名保留此值并增加 revision。v2 的成员按 ID 绑定，不能按名字吞掉同名分店。
`kind=complex` 的 `memberNames` 可用于检索组成地点，但不作为事实同义词；子项政策在 `components` 保存。
旧记录通过 `payload.canonicalRedirectTo` 重定向，保留原始来源、坐标和照片供审计。
`nameKeys` 由导入器生成，统一采用 shared `placeNameKey`（NFKC、空白、大小写），不剥机构后缀或括号。

`ResearchPoi.canonicalPlaceId` 与 `Activity.canonicalPlaceId` 是可选字段，以兼容历史行程。
活动 `id` 表示本次行程实例，与实体 ID 不同。新候选、排程、Trip 持久化和编辑都传递实体 ID；换地点必须清除旧身份。
详情编辑只在新版本副本补齐历史活动身份；分类以已解析地点为准，不能用模型给的“美食”绕过重复防线。
普通重复被拒绝（包括已绑定实体的餐饮别名），用户明确“再去/重访”且没有否定时允许重访。
上游“景点”或英文大类须映射成活动类别，不能因不在八类枚举中保留模型的错误“美食”分类。

## 4. 校验与错误矩阵

| 情况 | 行为 |
| --- | --- |
| 同城主名或确认别名 | 返回同一 canonicalPlaceId |
| 同名多个实体 | ambiguous，要求具体 ID/分店 |
| 跨城 ID、错误名称+ID、环/悬空链 | 不能解析成功 |
| 新自由名称类似已知地点且无独立坐标证据 | 提示核实，不作为另一个模型候选入池 |
| 旧导出覆盖 v2、已重定向成员再导入 | 跳过，不能复活旧实体 |
| 旧组合子项，且同批 v2 父子契约明确独立 | 仅在无 v2 同义归属时解除旧组合重定向，事务审计可回滚 |
| v2 revision 回退、跨城成员、双重归属 | 整个导入事务失败 |
| 相同 revision 却更换别名、主名或成员 | 拒绝；集合重排及内容更新仍可幂等导入 |
| 明确提供 null 经纬度 | 清空错误坐标，不保留旧值 |
| 已治理记录从resolved改为无坐标 | 同步geoStatus，goldset合并不能残留旧状态 |
| 名称、分类或别名对应向量文本变化 | 清旧向量，按新文本回填 |
| 回滚时业务数据或图片已变 | 拒绝覆盖；派生向量更新不阻碍回滚 |

## 5. 正例、兼容与反例

- 正例：济南“大明湖 / 大明湖景区 / 大明湖公园”经确认后同 ID；“老商埠 / 经三路老商埠”这批商业街区记录归入融汇老商埠。
- 兼容：没有实体 ID 的历史活动仅按精确名称兼容，处理新版本时从完整目录绑定。
- 反例：历史老商埠片区不等于融汇商业街区；大明湖不等于超然楼；不同城市人民公园、酒店不同分店不能同义合并。

## 6. 必须保留的验证

- `placeIdentity.test.ts`：同城别名、歧义、跨城、子项、旧 ID、环及实例 ID。
- `placeImportIdentity.test.ts`：真实 SQL、重跑、旧导出、连续重定向、坐标清空、照片、并发归属。
- `placeIdentityAudit.test.ts`：前后快照恢复、后续修改拒绝、旧图片清单解析。
- `placeIdentityFlow.test.ts`：历史行程副本、错误分类、追加日期、重访与换点清身份。
- `researchSubmission.test.ts`、`placeRetrieval.test.ts`：候选批次、SQL/向量与别名召回。
- 实际库验证探针应保持只读业务行为，不新建用户行程；测试数据库必须隔离应用库。

## 7. 禁止与正确做法

禁止 `normalizePlaceKey(a) === normalizePlaceKey(b)`、双向子串、邻近坐标或同游关联直接判等。
使用 `samePlaceReference` 比较已绑定实体，或通过完整同城目录解析；相似度仅提交待审。
禁止改名重新计算导出 ID。上游 `place_entity` 持久保存初始 ID，成员与变更记录分别存表。
不能只在结果排名阶段归一：确认别名必须进入 SQL 召回，并贯通候选、活动、图片及关系端点。

## 8. 实库持续治理验证

- 审核指纹与展示名分离；兼容旧指纹时保留原记录，通过当前实体对识别重复，不能重写历史决策引用。
- 同一现行实体对可能对应多个旧成员审核；独立/组成判断与回滚必须原子覆盖这些历史记录，释放REVIEW实体时也按当前主体判断未决关联。
- 原文优先厘清主体范围；相同地图落点不能证明连锁分店相同，地图误匹配到入口也不能把原文的商业体或景区强改成入口。
- 同名键仍有多个主体时，名称查询必须返回ambiguous，明确ID可选中对应主体；不能为“全城全绿”直接按大小写合并未核实分店。
- 实际查询验证与隔离消费链路分开留证。向量覆盖、生产超时内真实向量请求、SQL别名、旧ID、候选/排程/存储/编辑分别验证，单项成功不能代替整链验收。
- 排序精确奖励仅使用主名和同义别名。`complex.memberNames`可召回父景区作为背景，但不能使“天安门”在用户点名“天安门升旗”时压过独立子项；`placeRetrieval.test.ts`保留真实SQL反例。
- 独立餐饮负例始终让两家餐厅同池，但分别以各目标附近的真实景点构造排程场景。餐次择近可能只选其中一家，不能要求同一条自动路线用完所有餐饮候选。`negativeProbes[].scheduleScenarios`保存`targetIds`、`selectedIds`及`exclusions`；有合格锚点的目标必须以原ID入选，无合格锚点明确列为未覆盖。同一行程明确添加两家后的保存/编辑仍须验证二者独立。广州审核249/251的历史失败与复核报告用于复现这一边界，不能通过删除另一餐厅候选或编造坐标使断言通过。

## 9. 旧组合子项恢复

1. **触发范围**：v1 曾把城楼、广场、出入口折叠到景区，导致已有独立稳定 ID 仍被下游重定向。
2. **入口**：上游 `consolidate_places(..., catalog)` 按实体 ID 导出；下游仍走 `prepareImportedPlaces → seed-xhs-places → reconcileImportedPlaces`，不另写无审计修库 SQL。
3. **契约**：父项 `identity.kind=complex`，`components[].canonicalPlaceId` 引用独立子项；父子各有 v2 行，`memberIds` 只描述同义成员。组合子项不因行程粒度而消失。
4. **校验**：解除对象必须是尚无 v2 身份的 xhs/goldset 旧重定向行；同批父项必须以 ID+名称明确引用子项，现有父项必须是无重定向的 complex，父子不能互占 memberIds，也不能抢占其他 v2 实体成员。缺任一证据仍跳过；非法契约整批拒绝。goldset 的 UPSERT 在预校验通过后同样去除旧重定向，避免新 identity 与旧重定向同时残留。
5. **边界例**：天安门升旗与降旗分别导出；缺父项/只有组成名称不能自动恢复；已正确归并的 v2 同义成员即使携带旧独立声明也不能复活。
6. **验证**：`test_place_identity.py` 覆盖独立导出及政策隔离；`placeImportIdentity.test.ts` 覆盖真实导入脚本、金集图片/来源、重跑、逆序审计回滚；全城探针覆盖父子 ID 分别入池、排程和编辑。
7. **禁止与正确做法**：禁止遇到 v2 就清空全部重定向；按上述父子契约释放明确的旧组合成员。餐饮排程探针必须满足已核实坐标及附近景点锚点；不满足时分别报告自动排程未覆盖与明确添加后的身份验证，不能编造坐标令断言通过。

## 10. 大批量消费链路的测试账号

- `research/all-cities/verify-flow.mts` 每个持久化场景创建独立账号，单场景内初稿与重访版本仍共用同一账号，报告标记 `testUserScope=per-persistence-probe`。同城50个以上场景共用账号会让不同场景的行程与历史版本互相污染，失败无法归因到单个场景；不得靠清除中途数据来掩盖测试污染。
- 正例继续使用 `createTrip/getTrip` 验证初稿、重访和历史版本不变。独立/包含负例也必须实际保存两个明确添加的实体，读回后逐个ID断言只出现一次，才可报告 `persistence:true`，内存编辑成功不能替代数据库验证。
- `flow/run-15`保留厦门5项配额失败；`run-16`用55个厦门正例及全城111项独立/包含持久化验证修复。每次仍检查专用临时库的 `cleanup.json`，不读取或写入应用用户行程。
- 门店名中的街名可能是社区名或历史品牌的一部分，不能只凭它与地图地址的街名不同判为错店。重庆范嬢嬢春森路糯米团的公开门店正文明确“学田湾正街59号、春森路社区入口”；应保留有地址互证的坐标，修正原审核推断，其他泛名提及的归属另行核查。

## 11. 逐提及事实与逐图治理（已在batch-24首例应用）

### 1. 范围

同一旧源混有分店、机位或错抽取名称时，旧源ID不能代表全部提及和图片。上游实现保存在任务`research/upstream`并已安装；batch-24验证单源scope、纯错抽取和旧ID兼容。多个同名键旧源使用第14节联合范围；不能套用单源请求遗漏其他旧源。

### 2. 入口

- 上游`govern_place_identity.py --scope-decisions <json> --image-decisions <json> --out <json> [--apply]`：默认同事务预演；逐提及分配、实体纠正、逐图分配顺序执行。回滚不能混用其他决策。
- 下游`services/placeImagePolicy.ts:validateImagePolicy(place, previous?)`和`filterIdentityImages(place, images)`；地点导入预校验、图库合并、图片导入与`placeFacts`均使用它们。
- 上游新增`place_identity_scope / place_mention_assignment / place_image_assignment`，不覆盖原始提及、NoteImage.assignment或精选review。

### 3. 契约

受控地点`payload.mentionSources`列出当前已确认提及。此时`themes / typicalVisitMinutes / tips / mentionCount / recommendScore`采用上游权威替换；缺失时清旧值，金集不能取历史高分或保留混合时长。

`payload.imageIdentity`为`{version:1, mode:'reviewed', entityId, revision, approved:[binding]}`。`revision`等于实体revision。每个binding严格包含`imageKey / inputHash / sourceSha256 / assignmentRevision / entityId`，两个哈希为64位小写十六进制。普通图键为`note_image:<id>`，精选图为`photography:<note_id>:<image_index>`。

图片清单每张图携带`identityBinding`和`sourceSha256`，导入后保存在`StoredImage.provenance`。普通受控图片媒体文件名使用源SHA256；精选文件名使用转码后的`sha256`，保留原文件`sourceSha256`。旧序号文件仍保留用于历史引用。

### 4. 校验与错误

| 情况 | 处理 |
| --- | --- |
| 无受控策略的旧图库 | 维持既有稳定成员ID兼容 |
| 有策略但无逐图绑定、绑定其他实体或文件哈希不符 | 排除，不占三图名额 |
| 同实体同版本减少approved | 允许；同步清理旧封面和图库 |
| 同版本新增或恢复已撤销binding | 拒绝整个地点导入 |
| 已有v2实体同版本首次加入图片治理 | 拒绝，必须增加实体版本 |
| 受控策略被移除或字段非法 | 拒绝，不能退回普通图库 |
| 空approved | 清空图库、封面和旧amapPhoto；旧图单不能恢复 |
| 后台高德图片回写命中受控主体 | 内存和SQL条件均拒绝，避免并发治理后写回旧图 |

### 5. 正例与反例

- 正例：三条“站对面”提及纠正到机位，但“公交站”不留作同义词；旧ID+正确名可解析，旧ID+错名拒绝。
- 缺证据：受控新图、空目标或文件变化进入待审，没有合格图时保留空图库。
- 反例：两个分店共享旧品牌sourcePlaceId，不能把旧相册全部给任一家，也不能复制给两家。
- 同名键对应多个旧源时，`apply_scope_decision`在写入前检查所有本城源的`name / normalized_name`。其他匹配源未注册或属于不同现行根则拒绝单源请求；已经正式确认同根的成员可继续。仅按键覆盖所有提及、却只纳管一个旧源会使另一个源继续导出旧事实，不能将其视为联合治理。

### 6. 验证

`placeImagePolicy.test.ts`覆盖成员旧ID、哈希路径、同版本收紧、防恢复和先过滤再取三张。`placeImagePolicyImport.test.ts`运行真实地点/图片导入脚本，验证金集旧缓存清理、新旧清单交错、撤销、版本升级与错名旧ID。`placeIdentityAudit / placeImportIdentity / placeFacts / storedCover`保留回归。

上游`test_mention_identity_db.py / test_image_identity_db.py`覆盖真实SQL、完整提及集合、历史目标继续受控、文件与原审核指纹、两类图库、图片待审幂等、默认预演、迁移及倒序回滚。临时数据库必须保持`place_identity_test_<timestamp>`隔离。

### 7. 错误与正确做法

错误：从`memberIds`取到所有旧图库后直接合并；金集`recommendScore`始终取max。

正确：`filterIdentityImages(currentPlace, photos)`后再取三张，空结果显式清空；`mentionSources`存在时从本次受控事实替换统计和时长。按名称生成的旧介绍必须经过`entityId / revision / mentionHash`绑定，不能复用拆分前缓存。

## 12. 受控实体撤回与旧引用

### 入口和契约

`scoped_place_export.withdrawn_place()` 在普通 `places` 列表发送 `verified=false` 的显式撤回行。
`placeAvailability.validateWithdrawal()` 在任何写入前验证；省略导出行不表达撤回。

```ts
identityWithdrawal: {
  version: 1, revision: identity.revision,
  reason: 'split_source' | 'unavailable_source', candidateIds: string[]
}
```

- 保留稳定ID和身份成员，图片批准集合及mentionSources必须为空，坐标必须为空或缺失，不可携带事实、图片或语料。金集也清旧事实和向量。
- 同版本可撤回或缩减候选；恢复活动、扩大候选须更高版本。恢复还须提供当前可用提及，图片规则继续生效。
- 候选由被撤回主体所属scope贡献；联合组内旧源共享已确认目标，仅作为目标的分店不继承该组候选。下游必须验证**过滤旧输入后的最终目录**，同批被吸收、跨城、已撤回和重定向主体均不能成为候选。
- 身份索引读取撤回行但不放入groups；旧ID/泛名有候选时返回ambiguous，即使只剩一家也一样。无候选返回`{status:'unresolved', reason:'withdrawn'}`，与普通未收录地点区分。`add_candidate`与编辑新增草稿须拒绝此结果，即使裸名已有搜索坐标也不能走模型/外部补充回退。后续明确同义合并可沿正式redirect解析。
- 历史行程原样保存；编辑副本不将旧泛名ID替换为任一分店，明确新分店分别保留自己的ID。

### 关系与独立图片目录

逐提及关系使用第19节的来源快照与稳定ID契约。`loadPlaceRelations`不消费受控端点的裸名关系；旧格式关系导入持城市锁，拒绝缺失relations列表，空数组仍执行定向清理和审计，只清受控端点旧关系，保留其他普通关系。旧关系文件重复导入也受现行身份检查。

导入审计新增可选relations/relationImports快照，倒序回滚恢复关系及其导入记录；旧审计缺这些字段时保持原回滚边界。不能把后来新增的普通关系当作旧快照里的空集合删除。`--purge`不能删除已治理的xhs身份来绕过防复活。

独立人工选图库和模型审核图库使用第18节逐图稳定身份绑定；受控主体只从有效绑定补位，不进入裸名后台选图队列。校验输入名和实际命中的目录主体，防止别名/去括号回退借图。上游受控图库仍走现有imageIdentity校验后读取。

### 必要验证

`placeAvailabilityImport.test.ts`使用真实脚本、PostgreSQL向量及行程保存/读回/编辑；`placeRelationImport.test.ts`验证空清单、旧文件和倒序回滚。上游实导出覆盖双店、移空分店没有候选、PRIVATE及证据变化撤回。普通图库测试同时覆盖旧别名与括注回退的主体限制。

## 13. 治理台账的审核类型

- 入口：任务`research/all-cities/audit-live.mjs run-NN`冻结只读快照，`audit-reviews.mjs:auditReviews(entities,reviews,scopes)`分析。实体对、`mention_scope`、`image_scope`分别统计；不能用所有PENDING行数减实体对数来计算重复行。
- 契约：实体对继续按reason及现行根集合分组；提及按`mentionId + inputHash`、图片按`imageKey + inputHash`分组。`pendingPairs / pendingMentions / pendingImages`分别表示待审项，不代表已解决；`assessedUncertain*`只表示已有缺证据说明。
- 校验：只有实体对检查两个现行根；同根PENDING仍失败，跨城链/悬空/环仍失败。PENDING提及的scope须存在且同城；缺字段、未知格式计失败和`invalidPendingRows`。`missing_image`是合法图片待审，不能因没有原文件而漏计。
- 正例：一个实体对、两条未分配提及、两张待核图片分别保留计数。历史已解决版本不能抵消当前输入哈希的新待审。反例：把缺少entityIds的提及误报为`pending_same_root`，或把所有同城图片折叠成同一个空实体集合。
- `audit-reviews.test.mjs`保留三类混合队列、不同证据版本、错误根和run-20实城冻结快照逐字段兼容测试。审计结构无失败不等于待审实体已完成归一。

## 14. 多个旧源的联合范围

### 1. 范围

同城同名键的多个旧源需要逐提及分配时必须联合纳管。实现和成员表已安装；合成验证不等于具体实城已应用。

### 2. 入口

`apply_scope_decision(session, decision)`新增可选`sources: [{sourcePlaceId, sourceHash}]`；`sourcePlaceId`仍是稳定锚点。`place_identity_scope_source(place_id PK FK canonical_place, scope_place_id FK place_identity_scope.place_id, source_hash)`保存完整成员。`MentionIdentityCatalog.scope_for_source(place_id)`统一读取；旧单源无成员行时隐式只含自身。

### 3. 契约

请求包含全部匹配来源及历史成员、全部匹配及历史已分配提及；每条提及显式目标或null。校验所有来源根、旧目标、新目标版本并同事务递增。成员指纹变化使整组分配失效；未纳管新同名来源使正常消费拒绝，治理读取可通过`allow_source_conflicts=True`完整扩展。审计保存`scopeSources`和`inputs.sources / matchingSources`；旧单源快照不补空字段。

### 4. 校验

遗漏成员、跨城、过期哈希、换锚点、抢占其他scope及删历史成员均拒绝。REVIEW来源可纳管但不能作为分配目标，也不提升为ACTIVE。回滚检查全部成员、来源、提及、实体及派生状态，后续变化拒绝覆盖。

### 5. 示例

正例：双旧源联合分到两个已确认分店；两个旧ID共享候选而不自动绑定分店。基础：旧单源批次原审计仍可倒序恢复。反例：仅将同名第二来源的提及放入请求，却不纳管该来源；全null撤回只代表证据不足，不能作为合并成功。

### 6. 验证

`test_joint_mention_identity_db.py`覆盖双源、全null、REVIEW来源、扩展、冲突、图片和回滚。旧批次隔离重放与倒序回滚保持兼容。`verify-joint-scope.test.mts`从上游真实导出经实际导入脚本验证SQL、旧ID、事实/图库/向量清理、历史行程、恢复及倒序审计。

### 7. 错误与正确做法

错误：放宽单源重叠校验后只管一个旧主体，或把全null撤回当作门店归属已解决。正确：完整来源与指纹冻结，旧泛名显式撤回且提及继续待审，另行统计尚未解决的实体对。

## 15. 治理联调探针的真实接口

- 实际导入器接受`xhs-places*.json`文件名；生成器须保持该前缀。合成普通导出初态须有合格合成坐标，不能为通过探针修改实城坐标或放松导出资格。
- `PlaceIdentityIndex.groups`是成员数组的数组，枚举地点使用`groups.flatMap(group => group)`。`loadCityPlaceFacts`键使用shared `placeNameKey(name)`，不能直接用带大小写的展示名。
- 任务目录研究测试不一定包含在全仓tsconfig内；用专用`tsconfig.verify-joint.json`补静态检查，再跑实际脚本和隔离SQL。保留失败工件并区分探针错误与产品缺陷。
- scope-only批次的城市来自scope决策，不能只读实体合并决策。同步前必须冻结全部受影响ID的导出预期及其哈希，逐项验证显式撤回；全城报告单列`withdrawalProbes`，不能因verified过滤让旧失败静默消失。预演覆盖目录标记`plannedOnly`，正式同步后另做实库快照。
- “未认领旧行不变”探针须识别决策显式`mergeEntityIds`，逐个验证旧行重定向与主实体memberIds后才豁免；不能仅因当前存在redirect而跳过。批次外identity/redirect保持不变，受影响集合包含scope.expectedRevisions。batch32首次误报及修复保留，避免把探针遗漏当成产品回归或通过重放数据掩盖。

## 16. 撤回后的向量回填

- `scripts/embed-backfill.ts --tables places --city <城市>`仅选择`verified=TRUE`、无`canonicalRedirectTo`且无`identityWithdrawal`的行。批量模型返回后，UPDATE除核对文本输入快照，还须重查同样的三个资格条件；仅verified变化也必须拒绝旧请求写回。
- 导入时清向量不足以保证长期撤回，必须验证后续回填也不恢复向量或`embeddedText`。SQL/向量查询排除和实际存储为空分别断言。
- `embeddingBackfillIdentity.test.ts`运行真实回填命令、隔离PostgreSQL和本地模拟向量服务，覆盖撤回、待审、重定向、错误verified与撤回并存、模型等待期间资格变化、正常地点及二次运行无请求。
- 修复已误写的派生向量使用原冻结文件经正式地点导入（保留新审计）清理，再运行已修复回填器；不能重放上游治理决策或改写旧同步报告。

## 17. 从已审核提及创建实体

- `apply_scope_decision(..., newEntities?)`将新实体、逐提及分配、scope、关联待审和审计放在同一事务。每项完整提供`entityId/canonicalName/aliases/overrides/evidence`；新ID32位小写hex、expectedRevision=0，创建后revision=1、primary_place_id=null、legacy_ids仅自身。不得伪造原始CanonicalPlace或占用旧泛名ID。
- `evidence[]`逐条为`mentionId/inputHash/quote`，必须覆盖所有分给该实体的当前可用原文；主名和别名均需原文支持。可选`nameBasis={baseName,locationQualifier}`仅允许`baseName（locationQualifier）`作为地址限定展示名，quote须为原名紧随单行地址，限定词及显式address与该行一致。不能拼接另一店的地址、冒称官方分店名或据两种标签判独立。
- 城市锁后持全局ID锁。`can_claim_id`同时检查现存身份/legacy_ids和历史newEntities审计；回滚删除实体后，普通注册、bootstrap和别名认领也不能复用其ID。名称冲突须先复用或核实既有实体，不绕开同名源创建。
- `independent_scoped_place`只用实体自身overrides、当前已确认提及和imageIdentity；内部sourceEntityId必须指向无主源实体且有mentionSources，不能与sourcePlaceId共用。后续接入真实来源也继续此路径，不继承其未经审核的地址、行政区、坐标、缓存或图片。
- scope可空`withdrawal_entity_ids`冻结可拥有整组候选的旧来源主体。扩展来源时保留旧所有者，排除此前仅为目标的主体；分店后来成为member不自动成为旧泛名。撤回沿现行根解析。旧null从原来源推导，旧快照省略此字段，回滚须恢复null；幂等迁移只补列不改旧行或审计。
- 创建快照可选`createdEntityIds/createdEntityReviews`；旧批次不加空字段。后续提及、成员、图片、审核或事实变化拒绝过期回滚；倒序恢复后才可删创建时产生的审核和实体，历史审计保留。
- 必须保留`test_entity_creation_db.py`的创建/无坐标/事实隔离/证据拒绝/ID占用/注册后撤回/迁移兼容/倒序回滚，以及`preview-entity-creation.py`真实导出到`verify-joint-scope.test.mts`的真实导入、检索、保存、编辑和审计回滚。合成通过不等于实城分店已核实。

## 18. 独立人工与模型图库的逐图身份

### 入口和权威

`independentPhotoSources.ts`只读人工部署目录及模型审核目录；`independentPhotoIdentity.ts`保存下游`independent_photo_assignments / independent_photo_changes`。地点ID/版本仍由导入实体权威控制，不伪造上游NoteImage、photography或imageIdentity binding。

CLI为`node --import tsx scripts/govern-independent-photos.mts --decisions <json> --out <json> [--apply]`，在`apps/server`目录运行以读取对应配置。默认事务预演；snapshot与rollback独立使用，输出不覆盖。

### 冻结和并发

- 人工图键由city/snapshotId/selectionKey生成；审核图键由city/catalogName/sha256生成。inputHash冻结原条目、目录信息、人工排除及可用性，assetKey冻结本地字节或官方外链URL摘要。原选图不重排、不改写。
- 决策完整提供图片inputHash、expectedRevision、明确entityId或null以及新旧目标expectedEntityRevisions。持`place-identity:${city}`锁后检查来源城市、当前实体版本/活动状态和同城同资产归属。重定向、撤回或错城实体不能成为目标。
- 应用与回滚提交前均重读来源；文件、审核、身份、绑定或相关同图归属改变即拒绝过期操作。历史key不可重用。来源删除后用`digest(['missing_photo',imageKey])`形成可审计的显式撤销输入。
- 正常启动及受控迁移复用`INDEPENDENT_PHOTO_STATEMENTS`。地点导入审计可选`independentPhotos`检测后续绑定；旧审计缺字段时保持原边界，不删除新绑定。

### 正式消费

- `createGenerationPhotoLookup`先按当前实体ID/revision消费有效独立绑定。旧泛名目录里的不同图可分给不同分店，无需把旧目录名伪造成分店别名。
- 至少一张人工图可用即保序返回，最多三张，不混模型图；全不可用才用通过原人工排除的已绑定审核图。无匹配绑定应立即返回，避免为每个实体扫描全目录反馈。
- 已绑定、显式null、过期绑定及同城同图副本不能从旧名称路径复活。普通未分配来源保持原行为；受控主体无有效绑定不回退、不入裸名队列。逐层移除尾括注只用于阻止回退，不确认身份。
- 在线目录读取可`verifyBytes:false`避免整城逐文件哈希；最终adopter仍对实际采用的本地文件核验字节/媒体，外链保持官方URL和采用上报/署名。远端字节未经核验不得声称已验证。
- 图库别名与正式身份目录命中不同ID时单独核查，不将人工图库alias直接写入实体目录或自动合并。

### 验证

`independentPhotoIdentity.test.ts`必须覆盖双分店拆图、人工顺序/排除、错城与撤回/重定向、源哈希/字节/版本、同资产冲突、显式null、来源删除、应用/回滚期间来源改变、城市锁等待后重验、真实CLI及行程保存/编辑。补图禁止行为须记录并断言实际入队次数；异步`assert.fail`可能被正常降级catch吞掉，不能据此报通过。

真实图批次另留逐图证据、正式预演/应用、实库绑定读回、隔离回滚和原数据摘要。媒体资格通过不等于地点身份验收；合成测试或八张实图通过不能代表全城完成。

## 19. 逐提及无向关系与独立来源快照

### 解析与发布

- 上游`clean/mention_relations.py`保留所有已识别表层作为位置障碍，逐条调用`MentionIdentityCatalog.resolve`。未知、低频、未导出、未分配或失效的端点不能先删掉再把两侧拼接。长名优先；已审核的品牌提及仅在完整分店表层本身明确属于同一目标时借该位置，不能把子项位置给母项。
- 原文紧随母项的明确设施限定（方向门、正门/侧门/门口、出入口/入口/出口、游客中心、停车场、售票处，含括号）也形成完整位置障碍，即使该设施尚未注册。仅阻止母项借位置，不创建实体或授予别名；已有明确独立设施继续按完整名称解析。真实反例“大明湖北门→超然楼”“五龙潭南门出来就是趵突泉”不能作为母项关系证据。
- 两个已确认端点之间若仍有多个路线箭头，不能越过中间未识别文本建立关系，输出`unbound_route_segment`。真实反例“田子坊→思南公guan→新天地”和“豫园→taste of china味餐厅→外滩”；不据混写补别名。多箭头交通标注也保守排除，单箭头交通描述仍可正常使用。该规则以`sourceState.algorithmVersion=2`发布；下游保留算法1历史文件/审计兼容并拒绝未知版本，升级按新来源revision接纳，不改写旧发布记录。
- 同篇同品牌多次出现的受控提及需由唯一原文引用定位；无定位或同处归属冲突则排除。每篇保留双端点ID/revision、位置、表层、mentionId/inputHash、noteId/textHash；同篇重复只计一篇，至少两篇为direct。无向关联只参与同天聚类，不能表达身份相同或游览先后。
- `aggregate/relation_snapshot.py:publish_relation_snapshot`在REPEATABLE READ/SERIALIZABLE事务及城市锁中加载当前源，保存`place_relation_snapshot`。原文、归属、词表、门槛或图变化提升独立revision；恢复旧来源也不复用旧发布号。普通新增提及不提升人工实体版本。长会话读取须刷新ORM对象，不能借缓存覆盖并发发布。

### 导出导入和消费

- 算法3补齐“的南门”、编号门、站及编号出口（“香积寺站C口”）、地铁口和明确方向路段；站在/站着等动词不当作车站限定。否定/条件描述输出`conditional_or_negative_relation`；无箭头的分句描述须在最后分句有连接信号，不能从“日光岩俯瞰全岛，菽庄花园”借用宾语。下游接受已知算法1/2/3用于历史回滚，当前上游发布3。

- 地点及关系文件均带顶层`relationIdentity:{version:1,revision,sourceHash,relationHash,sourceState}`，与受控事实字段`payload.mentionSources`分离。两摘要分别覆盖完整来源声明和完整图，规范JSON按键排序、UTF-8、无空白，数值限定安全整数。位置按Unicode码点计，TypeScript须用`Array.from`。
- 常规地点导出同时写出同版本关系文件，并提交仅涉及派生快照的发布事务；不再是纯只读导出。一键同步按地点→关系顺序执行。任务同步记录分别冻结两文件哈希与成功步骤，关系失败时只续关系，不能重复地点导入；旧批次状态不追溯补造。
- 下游`placeRelationIdentity.ts`用TypeBox及语义校验检查唯一实体/提及、原文版本、端点归属/位置、自环/重复边和不同笔记篇数。不能先过滤无效或weak行再声称完整摘要通过。
- `placeRelationSnapshot.ts:acceptRelationSource`在地点导入事务保存声明及本次导出可用ID；声明推进即将图置SQL NULL，并清旧`xhs_relations`导入记录，等待匹配关系。即使旧地点行仍verified，本次未导出的ID也不能消费关系。
- `importRelationSnapshot`只接纳与已导入地点声明完全一致的完整图。数组`[]`表示完成挖掘但无关系，SQL NULL表示尚无匹配图。城市接纳后拒绝旧裸名地点/关系文件，旧实体版本、同快照版本改内容均拒绝；旧格式城市保持原兼容逻辑。
- `loadPlaceRelations`在同一SQL视图读取声明、图和本次可用目录，再按当前ID/revision及受控mentionSources核验。完整身份快照存在时不回退旧`place_relation`；关系增强异常仍为空Map降级。

### 审计和验证

- 新表`place_relation_snapshots(city,manifest,relations,available_ids)`在schema及`PLACE_RELATION_SNAPSHOT_STATEMENTS`同步定义，受控迁移复用启动SQL。
- 地点导入审计新增可选`relationSnapshots`，随地点及关系一起逆序恢复。历史审计缺字段而当前已有新关系快照时拒绝回滚；不能让旧审计覆盖后来发布。城市锁等待结束后重验来源，不能按等待前的旧版本写入。
- 保留`test_mention_relations.py`、`test_relation_snapshot_db.py`、`placeRelationIdentity.test.ts`以及`verify-mention-relations.test.mts`：原文定位、障碍、自环、错城/下线/过期、完整空图、双导入、Unicode、并发锁、SQL候选/排程/行程持久化/编辑及逆序回滚。无实际城市数据而提前返回的旧测试不能算真实城市验证。
- `research/audit-mention-relations.py`只读实城试算，不发布快照或迁移。弱证据、无定位及未绑定数量不等同新身份待审实体数；合成双分店通过不等于实城受控来源已有足够证据。
- 全城flow须在同一只读视图冻结身份目录和`place_relation_snapshots`，专用库按真实ID消费。边映射不等于实际排程；分别报告`mappedPairs`、`schedulePairMatches`和`associationFlowProbes`。每个可覆盖城市用一组实际坐标关联对执行SQL入池/排程/保存；无合格坐标单列，不能编造。

## 20. 金集导入与来源恢复

- `scripts/seed-canonical-places.ts`和`scripts/restore-goldset.ts`共用`services/goldsetPlaceImport.ts:importGoldsetCity(client,city,items,mode)`。调用方必须开启事务；每城持身份advisory锁，锁定现有地点行后捕获审计快照，避免与不持城市锁的图片回写相互覆盖。
- CLI默认读取`eval/snapshots`，支持`--snapshot-dir <目录>`和`--dry-run`；只接纳名称非空、坐标在有效范围内的geocoded活动。dry-run回滚地点和审计，启动schema迁移仍按原有机制执行。
- seed按完整城市目录使用统一身份索引。ID已存在、已由entityId/memberIds/重定向目标声明，或名称已确认/歧义/撤回，均不创建旧行；未知独立地点仍可新增。相似名称只是审阅候选，不据此自动合并或丢弃独立金集地点。
- restore仅对按原城市+活动名派生ID存在且source不是goldset的行恢复来源及caseId/activity溯源。合并保留当前payload全部其他字段，包括身份、撤回、别名、图库和提及策略；已有治理声明的类别不被旧活动覆盖。未治理行类别变化导致嵌入文本变化时清空embedding及embeddedText；先检查可选向量列是否存在，未安装pgvector仍能恢复来源和回滚审计。
- 有变化才记录一次城市`place_identity_imports`前后快照；幂等重跑无新增审计。关系快照、独立图片绑定、语料以及用户历史行程不随金集来源恢复改变。
- `goldsetIdentityImport.test.ts`使用真实CLI与专用PG验证旧ID/别称/撤回防复活、独立新增、字段与图库保留、向量失效、dry-run、幂等及倒序回滚。并发用`pg_blocking_pids`确认真实行锁等待，提交新图库后恢复与回滚均保留该图库。
- 全城核查须覆盖本次上游导出外仍可用的遗留行；未被上游认领不等于错误。冻结金集活动、原始提及和全文后逐项判断，不能只补向量输入声明就宣称身份已验收。

## 21. 重点清洗配额与错城来源

- 本任务后续主动清洗以`research/cleaning-scope/current.json`指向的冻结清单为准：每city景点50、美食30、咖啡/饮品10、购物10、机位10；稳定根去重后排序，补入必去与必要身份依赖。“云南”保留原桶，未知城市边界不自行拆分。
- 当前实体override优先；下游坐标为null时不能回退原源旧坐标。人工复核绑定实体revision与原文证据，实体变化须重新核对。主源分数不累加别名；推荐分、独立来源、质量均同分后，网格分布只用于排序，不作为判等依据。
- 精确同名必去源缺分/停用时，列为依赖和缺口；不得补造分数或借金集重新上线。未确认的相似参考名保持待核。共同scope和明确子项保留完整追溯；相似图只取与主清单及直接依赖相连的审核，不无限递归长尾。
- 清洗范围与兼容同步分别处理。已有身份、撤回及旧ID仍按完整城市快照同步；原始数据和范围外PENDING不删除。统计区分配额主体、必去补入、依赖、审核行/去重实体对，以及已隔离来源的归属待审。
- 原文明确错城且对应源只有该原文时，可按既有逐提及scope不分配目标并导出显式撤回；不得直接改RawNote.city、跨城认领或仅省略导出。当前null契约仍是PENDING，隔离成功不代表具体身份已解决。batch29保留真实37提及、撤回、幂等、倒序回滚和原文不变回归证据。

## 22. 重点清单的位置复核与进度

1. **触发**：重点来源的旧位置与原文街区或主体不符；位置修正与身份归一分别验收。
2. **入口**：任务研究工具`probe-shangbu-geo.py --city <城> --names <名称...> [--bare-names] --out <research内相对路径>`，从上游cwd运行；`freeze-batch28.py --batch batch-NN --city <城>`冻结现行实体预演基线；`check-priority-source.py --source <冻结sources.json> --batch batch-NN`在应用后只读核验原始资料。
3. **契约**：地图保存原CGCS2000坐标与GCJ-02转换值；候选返回不代表身份确认。修改仍走`apply_decision`和正式双同步，成对提供`lat/lng`；无法确认新点时清旧点并标`geoStatus=unresolvable`，不拿母景区、整条路或近邻点替代。原源不改写。
4. **拒绝条件**：证据路径越出research、输出已存在、城市被用户排除、冻结哈希/实体版本不符均拒绝相应操作；不关闭版本校验或覆盖旧证据。固定入选清单与当前实体版本不同须明确记录并刷新版本基线，不能把旧清单宣称新扫描。
5. **真实案例**：芙蓉街先返回章丘同名路，原文实际指历下老城；关帝庙同时有仲宫、芙蓉街、筐市街多个点，原文以五龙潭南门西侧/西蜜脂泉限定。趵突泉旧点精确等于同名酒店，清空后仍需分配公园/主泉池来源，不能直接认定为核心泉池。
6. **验证**：新批次必须保留真实SQL幂等/倒序回滚、正式预演、双导入、字段/旧ID、SQL/真实向量及历史行程检查。`check-priority-source.py`对冻结全部原源字段与提及指纹逐项断言；batch30核对107源/662提及。向量偶发不可用保留首轮结果，使用原生产超时单项复核，不加长超时伪装通过。
7. **进度口径**：逐项台账分别记录身份、类别、位置和媒体。`wrong_point_cleared_position_pending`表示坏点已清除、定位仍未完成；不能因新排名排除无坐标主体而将其静默移出台账，也不能把revision提升或待审队列为0作为城市完成证据。

## 23. 已确认非地点的逐提及排除

- `apply_scope_decision`的分配允许`entityId:null, exclusion:{reason:'not_a_place',quote:string}`。只允许这两个排除字段；quote须非空、不超过2048字、出现在当前可用标题或正文，并包含当前提及原名或规范名。不得用菜名词表直接推断，不把缺分店证据改称非地点。
- `place_mention_assignment.exclusion`为可空JSONB，旧行不回填。来源与提及指纹有效时解析为`excluded/reviewed_non_place`，旧空目标仍为`review/unassigned_target`。新提及不继承结论，原文或来源变化先进入原有待审分支；非法持久化排除返回`review/invalid_exclusion`。
- 无其他确认提及时用第12节显式撤回，保留旧ID和原文；不再提供地点事实、推荐分、图片或关系端点。路线表层仍保留位置障碍，不能删除菜品后拼接两侧景点。
- 关系来源声明的`mentions[].status`须同时接受`excluded`，且仅与`reason:'reviewed_non_place'`配对，entityId/revision必须为null。`validateBoundRelations`仍只允许resolved提及提供关系证据。不能仅通过上游导出就称跨端兼容；batch31首次下游预演因漏加状态枚举被拒绝，失败文件保留，修复后须通过真实双导入和倒序回滚。
- scope/catalog快照在exclusion为null时省略字段，保持旧审计形状和回滚边界。迁移只补列，锁住治理表后比较原字段摘要，原scope的withdrawal_entity_ids及所有历史审计必须原样保留；不能复用旧迁移脚本中“历史所有者列全null”的过时断言。
- `test_non_place_exclusion_db.py`覆盖真实SQL、重新待审、新提及/输入变化、非法引用、真实撤回导出与旧迁移/倒序回滚；`test_mention_relations.py`验证菜品障碍不虚增支持篇数；`placeRelationIdentity.test.ts`验证声明配对、禁止作为端点及真实双导入/回滚。实城另核验完整匹配集合、原文原源、SQL/向量撤回、旧ID/图库/历史行程。

## 24. 园区与核心景点的混合提及

- 同一裸名源混有整园、泉群、主泉池或机位时，按完整原文逐提及分配；明确穿园路线、园内多景点或公园全名可支持公园归属。附近裸名、路线名或全篇标签不足以单独证明具体泉池/摄影主体；真实地点证据不足继续null，不能使用not_a_place排除。
- 旧裸名ID保留为撤回引用，不因部分提及已归公园而将整个旧ID重定向，也不直接把它改成主泉池。母项提及中的“主潭”卖点不是独立抽取记录，不能据此伪造核心实体。没有已确认主潭提及时可以先治理明确公园提及，整组仍保留待审。
- scope去除旧混合主题后，依赖旧theme推断的活动类别可能退回默认值。依据明确原文另给实体category override，不继承住宿/美食等污染主题。scope与实体决定同批连续升版时，预演及原源检查须校验每步expectedRevisions、应用快照及最终实库版本，不把中间版本当终态；倒序回滚先类别再scope。
- 固定入选清单不重排。新增逐提及待审在当前进度单列，不能把冻结scope统计当实时队列，也不能转成长尾隐藏。batch33保留43真实提及/37原文、25公园/18待审、旧ID撤回/裸名与核心边界及真实向量检查。

## 25. 普通主体的逐项自查与独立图库

- 无需新治理决定的地点也须重新核对完整源成员、同名/别名匹配提及集合和原文指纹，再核现行类别、参考位置、旧ID、SQL别名及真实向量。不能为凑批次重复应用旧决定；自查记录与实体变更批次分别推进。三组济南文化地点的只读入口为`research/check-jinan-cultural-sources.py`和`verify-jinan-cultural.mts`。
- 下游导入器增加`identity.nameKeys`作为检索派生字段。比较导出与实库时分别验证原身份声明及按`placeNameKey`生成的名称键，不能因合法派生字段或JSON对象键序差异误报身份漂移，也不能完全跳过声明检查。
- 上游图库0、`independent_photo_assignments`为0均不证明独立图源为空。必须扫描实际城市原目录并检查无读取警告/非法文件，再按名称、别名和稳定ID查看匹配图源。济南实际12目录/123图、旧资格28条，本轮博物馆13图和教堂9图逐图核查；旧模型match不等于当前主体已确认。
- 同目录误配图若已被质量/身份门槛拒绝，不必重复写null。null及正分配均会阻止同资产旧名称回退；撤销前检查同资产的其他目录，避免因某目录误配影响另一地点的正确图片。独立图片第二批只写4确认绑定和1错误正例撤销，17原拒绝保持。
- 图源原视角字段与本轮观察不同，应在证据中准确描述，不借身份治理改写原选择/排序。按现行view去重后展示数可能小于绑定数；实际探针须分别验证每张绑定可用，再验证正式图片入口只返回确认集合及正确别名，并报告两个数量。
- 独立图像批次与上游实体批次独立编号。正式应用前保留实图隔离幂等/回滚和实库事务预演；应用后核对真实分配、原目录摘要、其他已有绑定和历史行程。AI自查通过仅推进城市固定清单对应行，不能标记城市或整体任务已获用户验收。
- 拍摄自楼体的观景图可在作品页明确拍摄地点、画面语境一致时绑定对应地点，证据须标明“从楼上望外”，不能冒称楼体照片或据此合并被摄母景区。超然楼T10保留Commons作者说明，四绑定逐张验证与正式三图展示分别计数。新批次隔离验证须带入既有分配，回滚恢复它们；应用后仅比对本批读回，不能要求整城分配全等本批。
- 原源地图坐标可能保留高精度。上游`export_to_tripweaver.py`先将原源坐标舍入六位小数，后续`consolidate_places`再原样应用实体`lat/lng`覆盖值，覆盖值不会再次舍入。探针按实际数据分支精确比较，同时校验导出文件指纹与实库值；不能一律要求六位小数或扩大任意距离容差。第38批西更道街保留治理决定的地图原精度。
- 同篇原文出现正确主体，不代表该提及的`reason/evidence_text/fact_value`都属于主体；逐项自查须同时核对这些实际消费字段。泉城广场12580借住宿段性价比、12913错写五龙潭东门，即使名称可辨也不能直接分配并传播整条事实；现契约无法仅修该字段时先null隔离并保留待审，不将其改称非地点或宣称身份未知。原判断被更强证据纠正时新建核查记录，旧工件保持；隔离后的提及数量另计，固定重点清单不删除。
- 普通未受控地点可能从全城图片事实池消费政策，来源不一定有该地点的`place_mention`。自查除提及关联原文外，还须追溯导出的`openHours/price/reservation/tips`来源、逐条检查图片文字的主语；补充原记录及指纹单独保存，不改固定清单或旧冻结哈希。三个公园的三篇提及原文之外有2549/2568图片政策，必须把博物馆时间、预约和“泉城公园站”的交通文字与公园分开。读取既有图片分析不等于本轮查看原图，来源归属明确也不等于最新官方政策已确认。

## 26. 逐提及事实字段排除

- 主体身份明确、只有某个事实字段错误时，完整scope分配可携带`factExclusions: {visit_duration: {reason: 'group_duration', quote: string}}`。时长理由支持`group_duration`，以及第30节的`subject_mismatch`；描述字段扩展见第28节。目标必须为非空实体、原提及有有效分钟数，引用须来自当前可用原文并含提及名称。不能混用非地点排除、替换分钟数或凭关键词自动裁定组合时长。
- 上游`place_mention_assignment.fact_exclusions`为可空JSONB。有效决定仍解析为resolved，保留描述和实体；`effective_fact_value`复制消费投影并去除minutes，不改原始提及或inputHash。输入变化重新待审；非法持久化策略为`invalid_fact_exclusions`，不可退回错误值。快照null时省略新键，倒序回滚恢复原决定，迁移不改旧行。
- `summary.mention_groups`与`scoped_facts(..., mention_catalog=...)`共用投影，真实导出、无原源实体导出及QA必须传入当前目录。受控导出不能读旧canonical时长缓存或通过整篇挖掘补回。下游沿mentionSources权威替换清空旧`typicalVisitMinutes`，包括金集来源。
- 济南四泉的合计30分钟不得分别赋给单点或平均分配；起凤泉唯一提及保留resolved。刘氏泉另一条摄影语境提及继续null待审，与时长字段排除分别处理。时长事实修正不等于类别、位置及整组自查完成。
- `placeFacts.toFacts`读时长，但实际`buildDraft → visitWeight`按类型/类别分量排程。不能把事实库四个30分钟推断成真实行程多排90分钟。验证独立有效时长保留、旧时长清除、有效描述/身份不丢失及排程分量不变。
- 验证入口：上游`test_mention_fact_exclusion_db.py`覆盖SQL、引用/输入校验、投影、导出、迁移和回滚；下游`verify-mention-fact-exclusion.test.mts`覆盖真实CLI双导入、金集清旧值、SQL/旧ID/事实消费、幂等、旧文件拒绝和倒序回滚。正式批次另做完整城市导入预演与实库字段、SQL/向量、原文、图库和历史行程检查。幂等比较只忽略既有导入时间戳；回滚仍完整精确比较。
- 后续仅类别升版也必须验证已有scope分配和factExclusions保持：真实实库字段决定逐条比对，既有待审不得变resolved，清除的错误时长不得恢复。第37批五泉预演在专用库带入第36批真实分配，逆序回滚恢复到第36批状态，不重放实城决定。
- 批次预期可同时包含普通来源和受控来源。scope预校验始终要求mentionIds；仅实体修订的普通预期未给mentionIds时，导出也必须没有mentionSources。不得用可选链跳过受控校验。导出已生成但后置校验失败时，保留原文件，修正校验器后验证地点/关系同源及哈希再登记状态，不能盲目重新导出覆盖证据。

## 27. 正文时长抽取与旧派生缓存

- 上游`build_visit_duration.extract_note_durations`先检查整句否定、时间预算、通勤和路线语义，再按地点前后20字符取值；不能先截掉“不建议安排”再把“半天”归一成停留180分钟。灵岩寺note2609第5页真实原图是该反例，`test_build_visit_duration.py`同时保留独立推荐、无关出行建议、组合地点与通勤负例。
- 同篇同地点同分钟数只贡献一次，正文、图片文字、key_info摘要和重复提及不能重复加权；不同笔记仍独立计数。纯字符串时长归一器不负责判定事实语义。
- 原提及没有minutes时，不伪造`factExclusions`。完整scope保留有效提及，由受控导出重建事实并在下游清旧时长。原canonical缓存仍可保留追溯，必须明确区分“已停止消费”与“数据库字段物理清空”；禁止为了匹配期望直接改原始数据。
- 真实资料隔离夹具需带入原笔记source_url，不能因遗漏来源链接导致看点为空，再降低“有效描述保留”的断言。第39批首轮失败与补齐来源后的幂等、导出、倒序回滚报告均保留。
- 受控描述的observedAt可能随导出时间刷新。跨批次比较描述内容时可仅去除该既有派生时间，但实际新content仍须与冻结新导出完整精确一致，quote/strength/sourceUrl等全部比较；原始提及和原文指纹不变性仍独立核验。

## 28. 描述主语错误的字段治理

- `factExclusions`支持`reason`、`evidence_text`、`place_content`，理由仅为`subject_mismatch`。可与既有时长排除组成非空集合，每项严格为`{reason,quote}`。引用须来自当前可用标题或正文并包含当前提及名称；对应原字段必须存在。不接受替换文字、空对象、未知字段、无实体目标或混用非地点排除。
- `effective_mention`在消费副本清除指定理由/证据，`effective_fact_value`清除指定`placeContent`；原始提及、指纹及有效身份不变。整块`placeContent`排除前须核对所有看点，不能仅因其中一句错误而丢弃其余有效信息。
- `summary.mention_groups`、`scoped_facts`和介绍提纯的社区来源共用字段投影。被排除内容不能由同一提及旧reason兜底恢复；reason排除不影响独立有效evidence_text。介绍缓存仍绑定原始提及指纹与实体revision，新完整scope升版使旧介绍失效。
- 下游无需新增协议：真实双导入按`mentionSources`权威替换描述，重建社区语料、清理旧金集介绍，嵌入文本不得再带被排除描述。不能把有效单例提及改为null或撤回整个地点来规避字段错误。
- `test_mention_description_exclusion_db.py`覆盖SQL分配、非法引用、输入变化、摘要、来源投影、实际导出、幂等及倒序回滚；`verify-description-exclusion.test.mts`使用显式指定的新导出夹具验证真实双导入、金集清旧值、独立有效字段、SQL、向量输入与逆序回滚。旧错误语料须达到普通导出的10字门槛并实际入库，才能证明后续删除；不得移除旧语料存在断言使测试通过。
- 图片比对被用户暂缓时，记录`deferred_by_user`，继续有正文依据的字段治理。数据库图片字段保留检查不等于视觉核查；不据此增加完整自查数量或将整项标为验收通过。

## 29. 导航参照误当主体时的细分类修订

- 上游既有实体决定和独立实体创建的`overrides.xhsPlaceType`为可选字段；当前只接受抽取器七种类型：`attraction / food / hotel / cafe / market / photo_spot / other`。显式null、空串、布尔值、对象、未知值及错误大小写均拒绝；省略不影响旧决定。两入口共用`validate_place_type_override`，导出沿既有payload覆盖机制处理，不改原始源或提及的`place_type`。
- 原文“搜索茶馆，其前平台拍摄”中的茶馆是导航参照。完整scope确认提及仍属于摄影主体后，可保留稳定ID、纠正主名、通过`excludeNames`移除裸店名，并分别修订粗类别和细分类；不能仅改展示名或粗类别而使检索/排程继续读取`cafe`。未知精确坐标保持null，不能借茶馆地址/POI推定平台落点。
- 正例：第41批“尚泉尚水茶馆前平台”以自然类、`photo_spot`导出，原12653提及及摄影看点保持，旧ID+正确平台名可绑定，旧ID+裸茶馆名拒绝。前缀搜索可能召回平台作为相关结果，不代表允许把茶馆与平台解析为同一实体。
- 校验须包含实际导出、scope与实体决定幂等、逆序回滚、原源指纹不变；下游以真实城市导入证明旧餐饮命中到新餐饮排除，并调用实际`loadCityPlaceFacts`读取细分类、`visitWeight`读取分量。无坐标时不能声称自动地理排程覆盖。
- 导入器会给`identity`增加`nameKeys`；验证应完整比对上游身份声明，并独立校验这个派生索引，不能直接把带索引的实库对象等同于原始导出对象，也不能跳过整个身份校验。使用`db/client`的隔离检查须先验证临时库环境再动态导入，防止顶层自动迁移误指应用库。

## 30. 景区内活动时长与关系位置绑定

- `visit_duration`可用`subject_mismatch`排除属于乘船、登楼等另一主体的分钟数；`group_duration`继续表示多个地点的合计时长。描述字段仍只允许`subject_mismatch`。理由先验证字符串再判断允许值，避免对象或列表触发类型异常；目标、原有效分钟数、当前原文引用和字段白名单等既有约束保持。沿既有消费投影生效，无新增下游协议或迁移。
- 大明湖12700原30分钟明确属于船上时间。提及仍归景区，有名称限定的乘船描述保留，只移除消费分钟数；独立120分钟环湖及明确17:30–18:30游览保留。原canonical缓存与原始提及不改写，不能把删除一个数字宣称为清除全篇乘船描述。南门起点的一小时街区线路同时存在目标和时长范围问题，可继续null待审，不能机械归到同一字段排除。
- 大明湖/大明湖公园/大明湖景区已有明确正文互证和同义治理时，裸名也可在完整原文支持下归既有景区。不能套用其他混合裸名源的撤回结论而全量拆开；门、灯塑、摄影位置、酒店、餐馆与楼体继续独立。三源65提及的第42批确认48、待审17，原三历史ID与坐标保持，不增加完整自查或用户验收数。
- 受控提及身份已resolved仍不保证正文任一同名位置可作为关系端点。同篇多次出现且旧提及quote不能定位时，现行`ambiguous_text_occurrence`保留位置障碍；无对应抽取表层为`no_mention_binding`。第42批大明湖到曲水亭街/超然楼仅保留note2622的明确位置证据，两边降为weak，20关系总数不变、direct由9降7。逐一对照旧端点字符位置验证原因，不把降级全部归因于新增待审，也不为保留强关系取消位置校验。
- 仅含scope而`decisions=[]`的批次，通用`verify-batch`别名探针会为0。须显式`--vectors --ids <现行根ID>`并用专项真实SQL核对全部别名和旧ID、独立主体+根ID拒绝；实际`loadCityPlaceFacts`须读取有效时长与别名。不可修改已冻结决定来填充探针数。
- 真实隔离夹具带入原历史实体、成员映射与既有审核行，重定向根须先于依赖行插入。第42批验证3源/54全文、消费投影、幂等及逆序回滚；`test_subject_duration_exclusion_db.py`另验证SQL/实际导出及非法引用、无目标/无分钟等拒绝。库内空图片字段保留只作数据不变性证明，图片比对暂缓时不得声称视觉验证。

## 31. 预约主语排除与独立时长样本

- `factExclusions.reservation`只接受`subject_mismatch`及当前原文引用，原`fact_value.reservation`必须是布尔值，不能将数字1或字符串true当布尔值。继续要求明确实体目标和同主体原文；不允许写替换政策。消费投影删除该键，`scoped_facts`同时禁止凭原`fact_type=reservation`重新兜底。描述仍可保留有明确活动主语的游船预约说明，不能传播为整个景点的预约证据。
- 无独立有效预约来源时输出unknown和空reservationEvidence，而不是推断为无需预约。独立的required/none来源仍保留。第43批黑虎泉12929原布尔标记来自“坐船需要提前买票选座”，原普通导出虽为unknown，受控后也不能把该船票文字列入景点预约证据。`test_reservation_fact_exclusion_db.py`覆盖三态、原描述保持、fact_type兜底阻断、真实导出、非法输入、幂等及回滚。
- `summary.mention_groups`和`scoped_facts`都按当前实体内的`(raw_note_id, int(minutes))`去重，同篇重复抽取不重复加权，跨篇相同分钟仍计数；保持既有排序后中间偏上的中位数规则。原提及/mentionCount不去重，原canonical缓存不在治理时改写。修正前先对本次重导出的既有scope比较中位数，避免无版本说明地改变其他主体的事实；第43批济南4个已有非空时长scope数值均保持。
- 合计时长同时出现在`reason`中时，只删除minutes仍会让描述消费错误数字。第43批11336/12564排除组合60分钟及错误单点reason，保留独立有效evidence_text；黑虎泉有效30/50/60三个独立样本导出50分钟。千佛山12851的20–40分钟只表示登顶路段，不能当含下山和其他游览的整次停留，排除标量而保留有界登山说明。明确14:30至15:20实际行程安排的50分钟不能仅因同段出现游船就误删。
- 同篇还影响其他主体时，记录未应用发现，重新打开被证据否定的AI自查状态，不删除历史台账。解放阁11337/12565仍有组合60分钟，当前最终30分钟不证明错误来源已治理；曲水亭街/百花洲的组合90分钟也分别待核，曲水亭街另有360分钟旧缓存需追溯。未应用发现与正式PENDING队列分开统计，不能提前宣称下批已修正。

## 32. 提前准备时间与局部街区范围

- 第44批在note2554正文复现曲水亭街360分钟唯一抽取样本：“不太推荐曲水亭街的店建议提前一天找好，避免浪费时间”。`build_visit_duration`在整句过滤`提前/提早 + 时长`；准备、预约的提前量不是停留时间。同句同时出现游览时长和提前量时保守不抽；分句独立游览及无提前量的预约提示仍可保留。正文、旧图片文字分析、key_info使用同一门槛，原始文本不改写。复现当前函数不等于已证明历史写库日志。
- 旧缓存与原提及分别检查。曲水亭街11495/12747没有minutes，不虚构字段排除；完整scope停止旧360分钟缓存消费，由独立30/50/60分钟样本重建50分钟。解放阁三篇独立30分钟各自计数，同篇重复仍去重；合计60分钟及两主体合计90分钟同步排除错误reason。百花洲书香胡同机位的两条60分钟因主体范围不足待审，整地时长未知，不能随意补值。
- 百花洲湖与环湖小街区不等于同时包含曲水亭街的“百花洲历史文化街区”。已有曲水亭/曲水亭街同义治理保留；一篇混用名称的错误事实不自动推翻其他充分证据建立的同义关系。联合scope须带入两个原成员、重定向实体及已解决审核366，验证幂等和倒序回滚后全部还原。
- 明确路线主体的提及若仅reason/evidence借全城泛化描述，可以排除这两个字段保留主体。第44批仅有整块排除能力时，混合独立子点与本体有效看点的placeContent保留待审；第36节增加逐条排除后，须重新核实主体和各看点才能推进，不能机械批量确认。
- 第44批18条现行关系/3条direct，解放阁—曲水亭街与芙蓉街—百花洲的旧位置证据全部失效；三条旧direct各剩一篇。逐位置诊断均为`ambiguous_text_occurrence`，不是提及待审数量增加本身导致。主体分配resolved和路线位置绑定必须分别验证，禁止为了维持原关系数量放宽绑定规则。

## 33. 文字治理对独立图库的影响与道路机位边界

- 新增文字scope前同时冻结上游图、下游图片字段和独立图库。`isScopedReference`在`mentionSources / imageIdentity / identityWithdrawal`任一字段存在时即为true；即便不添加imageIdentity，仅新增mentionSources也会阻止未绑定的名称图库回退。零上游图、零旧图片字段不能证明没有消费影响。
- 第45批实际目录隔离消费证明老商埠返回3图、经三路返回1图；内存中仅增加mentionSources后均变0。图片比对依用户要求暂缓时，保留这两个主体既有数据与路由，文字发现另记未应用。不能用旧eligible元数据自动创建逐图身份绑定，也不能弱化受控主体的防回退契约。只做哈希/字节保全和查询结果比较不等于查看图片或视觉验收。
- 经三路道路、融汇老商埠商业街区、纬三路与经三路交叉口的爱心斑马线、爱心红绿灯及夹心胡同是不同粒度。note2566路线首站支持路口斑马线，不支持与红绿灯同义；全线1至2小时不能补为路口停留。note2793的纬三路红绿灯限定不能在reason里丢掉；当前placeContent保留限定时不能一并删除。
- note2797抽取名“经三路爱心红绿灯”在正文为“爱心红绿灯：经三路，爱心红绿灯和夹心胡同都在这里”，没有连续主名。第45批时`validate_fact_exclusions`拒绝不包含连续原提及主名/规范名的摘录，因而未应用；第46批按第34节增加显式标题引用后完成字段修正。仍禁止篡改原文、伪造拼接quote或绕过主体校验。
- 大观园正文为整体商业文化游览主体；公开地理位置与地图查询结果否定旧经二路728西侧点，但整体、欧亚商场及入口的精确点不能互借。可保留已证实的经四路与纬二路概略地址、lat/lng=null和unresolvable，不把清错点记作精确定位完成。
- 全城导出会重新生成普通提及内容的`content.compiledAt`。批次外主体保全检查单独报告这个时间差，仍严格比较全部事实、身份、坐标与图库；不可笼统忽略整个content或payload。第45批经三路与红绿灯仅该时间变化，独立图库来源摘要、实际返回结果及9条绑定保持。

## 34. 限定标题的显式事实引用

- `factExclusions.<field>`沿用`{reason,quote}`，可显式加`subjectAnchor:{kind:'qualified_heading',subject,qualifier}`。键固定，两个片段各2至128字符、不能含换行或断句标点；按name_key归一的`qualifier+subject`必须精确等于原name或normalized_name。无anchor仍用旧连续主名规则；有非法anchor时不能借旧规则通过。
- quote仍是当前可用note_title/desc的原样连续子串。完整原文中由quote覆盖的位置必须唯一匹配`subject：qualifier`或英文冒号形式，冒号两侧只允许同一行空白；subject之前不能紧接字母/数字/汉字，qualifier后必须是句读或原文末尾。不能在quote截断后再检查边界，从而剪掉“非”或“东段”制造主体匹配；重复正文/标题不能唯一定位时拒绝。
- 这是人工字段判断的证据绑定格式，不推断语义、不自动拼接身份名称、不创建别名、不扩展not_a_place排除。继续使用完整scope、原文指纹、实体版本、城市锁及现有JSONB审计回滚，无迁移；下游mentionSources契约不变。
- `test_qualified_heading_fact_exclusion_db.py`覆盖真实SQL幂等、导出、逆序回滚、三描述排除与独立75分钟保留、原始指纹保持、错误限定/主体/跨句跨行/长名截断/重复标题/可选字段非法拒绝、存量anchor篡改及正文变更重新待审。不可用原文按既有DELETED/PRIVATE状态模拟，不能用不受识别的UNAVAILABLE状态冒充测试。
- 第46批12776的reason/evidence_text/place_content三字段已清除，原名、稳定ID、photo_spot及先前NULL坐标保持；原始混合描述仍保留追溯。内容为空时不能从邻街、夹心胡同或旧缓存补回。五个周边名称与旧ID边界、真实placeFacts、SQL/向量及图库3/1保全另验；精确位置和图片比对仍未完成。

## 35. 街道经历、市场范围与住宿评价

- 街道早餐经历不确认某一家餐馆，也不能仅凭市场包含街道名而把街道全部提及分给市场。第47批保留民族大街两条同篇早餐提及及民族大街市场独立提及，既有审核369的part_of完整保留；道路food修订为other，原源类型不改写。
- “图示C区缺点：离民族大街稍远”是住宿区域评价；文字不能定位该区域时不猜图示位置，该warning继续待审，不能传播为道路负面评价。保留原输入和稳定名，不用not_a_place替代缺证据。
- 有来源的消费经历语料与静态介绍分开验证。既有`intro_rejection`可以拒绝早餐价格作为intro/topReasons，同时保留去重后的xhs_reason；不能要求所有有效提及都生成非空介绍。受控themes按既有规则为空，原theme_tags缓存保全不等于有效主题沿用。整城实际消费、历史语料存在及新语料清除应分别断言。

## 36. 混合看点的逐条排除

- 仅`factExclusions.place_content`支持可选`highlightIndexes`；不提供仍为原整块排除。原placeContent须version=1且含至少两条非空text/quote对象；索引为递增唯一整数列表，不能为bool/null/负数/越界，必须保留至少一条看点，全删用原协议。
- 排除quote仍须来自当前可用正文/标题并指向当前提及主体（可沿用第34节subjectAnchor）。每个选中看点的原quote须被该摘录完整包含；不能借另一看点的引用删当前项。所有原始字段仍参与指纹，看点数组换序、改文及正文变化都重新待审。
- effective_fact_value只在深拷贝筛掉指定索引，剩余text/quote和顺序不改。完整scope及实体升版使旧profile失效，原place_content排除标记继续阻止reason回填；reason/evidence_text混有同错时分别排除。无迁移、替换文字或下游协议变化；原始提及与旧缓存不改写。
- 第48批12592保留泉池气泡、删除大院园林评价；12582保留院内泉名单、删除“大院为名泉之一”。10条提及保持，60/30分钟独立样本保持，不通过整条待审回避已明确的字段纠正。尚不能确定主体或同一条看点内部混合时仍须另核，不因支持逐条排除而自动确认。
- `test_highlight_exclusion_db.py`覆盖真实SQL/导出/幂等/逆序回滚、旧缓存/社区源不复活、原样本和剩余看点、非法索引/不匹配引用/原数组换序/持久策略篡改及旧协议兼容。下游另核真实旧语料存在、新错误语料清除、剩余看点与原scope保持，不以非空介绍替代正确性验证。

## 37. 已有联合scope的局部再审

- 再审既有scope必须冻结完整成员、现行scope/实体版本、全部分配及排除策略、历史重定向和审核行。完整决定仅替换本轮核实的提及，其余分配保留。第49批曲水亭街两源56提及/45全文中，仅11369和12610由待审转确认，其他54条策略不变；scope从1到2、根实体从3到4，全部56条分配按既有协议升为revision2。
- note2546独立曲水亭街条目明确街道风貌：排除混入起凤桥机位的reason和看点1，保留街道看点0及未混入机位的evidence_text。note2837百花洲12946为两地共同描述，不能仅凭分开的看点断言小店、茶座都属于百花洲，仍待审。细粒度删除能力不代替主体与事实归属证据。
- 真实隔离SQL夹具先插入原提及再插入已有分配，保留外键约束。回滚验证须还原原scope、所有分配/字段排除、重定向、审核、摘要、来源和关系，不应断言“scope为空”。实库多批校验按mentionId选最新决定，不能要求已升版的56条分配仍等于第44批revision1。
- 关系变化须区分实体版本刷新与语义变化。第49批6条涉及曲水亭街的关系及其证据端点仅revision3→4，原字符位置、引文、提及绑定、强弱和18条关系集合完全保持。恢复两条身份不代表note2546的重复名称位置已可唯一绑定。

## 38. 无具名POI的店铺坐标与日期回填溯源

- 不同店名查询返回同点、转换后恰与原源一致，只证明当前地理编码可复现该值；没有具名POI时不能称为门店定位，也不能据此声称查到历史写库原因。城市查询若返回另一点，不把旧点笼统命名为城市中心。第50批两个独立店铺清空消费坐标、保留原源，清错点不算精确定位完成。
- 同篇分别介绍的vintage杂货铺和咖啡店保持独立。原shop可通过实体category覆盖改为购物，原cafe仍为美食；不需要为位置/类别修正新增文字scope。具名地图支持的门牌可以独立于坐标采用；候选分店、附近同品牌商店、街道点不能自动作为别名或当前门店点。原文无法确定VILLA SHAKA的纬四路/上新街分店时保留未知。
- 实际placeFacts索引以`placeNameKey`访问英文名称；无坐标使用缺省字段，不能要求存在值为undefined的键。无scope且无图的主体可能按既有路径触发补图请求；隔离测试比较前后mock回调与实际返回，显式记录真实入队0，不把mock回调数写成0。
- 全城内容保全须逐字段比较。`observedAt`如有变化，仅在旧值精确等于旧`compiledAt`且新值精确等于新`compiledAt`时单列候选回填差，并继续比对text/quote/sourceUrl/strength/顺序/intro；此模式本身不是来源日期缺失证明，必须追加真实来源溯源。
- 第50批148看点/127实体匹配165条提及/32篇笔记，所有匹配均已有`RawNote.created_at`。当时普通与受控legacy reason路径调用`legacy_highlights`未携带observedAt，构建内容才用编译时间回填。第50批将其记为独立未修复元数据问题，后续修复见第39节；不能混入商业scope发现或称为数据保全完全无差异。原错误解释证据不覆盖，由补充报告明确更正；日期含义以源字段为准，不推定为旅行或发布时间。

## 39. 旧看点来源日期与独立元数据刷新

- 第38节日期问题在metadata01修复：普通导出与受控事实的旧reason分支都补传原`observed_at`，与结构化看点分支一致；来源日期实际缺失才沿用原compiledAt回填。分句函数继续只负责分句，日期在掌握来源上下文的调用处附加，不改原始记录、过滤门槛或实体版本。
- 元数据修订无实体决定或scope分配时单独登记，不能为复用实体批次脚本构造空治理决定或给实体无意义升版。源/图哈希未变则沿用当前关系revision；匹配旧图在内容刷新中仍有效，不套用新来源版本的暂时禁用断言。
- 实城只读预演如替换发布器，必须由数据库强制只读，并重建、比对当前源/图哈希后才复用已发布revision；普通事实构建及导出逻辑仍执行真实代码。用两次完整导出验证日期稳定和其他字段保持，不能只凭纯函数测试宣称实库修正。
- `content.observedAt`为来源日期，`content.compiledAt`为本次内容构建时间，`research_evidence.fetched_at`为导入器重建语料的时间，三者分别核验。仅允许已溯源的看点日期更正；语料导入时间须落在真实导入窗口且ID/内容/来源/强度/向量全保持，不笼统忽略其他差异。
- 日期不参与现行`placeEmbeddingText`；输入文本与既有向量全保持、有效主体无待回填时无需重算。metadata01验证148看点、238旧行/232向量、524语料、90图片字段/9绑定、双导入幂等及逆序回滚；图和身份回归输入另与已通过冻结完整比对。范围外城市未重导出时不得宣称其存量日期已全部修复。

## 40. 原文门牌、地图探针异常与导入前置检查

1. **触发**：原文逐店列出地址，旧点与所述街区明显不符，具名搜索没有对应门店。第51批六家餐饮店有12提及但仅1篇独立原文；分别保留原名、ID、food/美食，不按同篇相邻合并。
2. **入口**：`apply_decision`以既有override补`address`、清`lat/lng`并置`geoStatus=unresolvable`；无需新增文字scope。地图探针仍用第22节命令。新批导入顺序为`check-batch-state.mts before <batch>`再`sync-batch.mjs <batch> import`；后者写入前检查成功前置工件，失败必须停止编排。
3. **契约**：文字地址不等于精确定位；公园门口、街道其他门牌只是参照，不能借用其坐标。地图`matched:true`仅表示有返回候选；跨城同名店不作本城证据。日期修复后的旧看点必须稳定，不能继续忽略observedAt变化。
4. **校验与错误**：`safe_error(error)`仅输出异常类名及HTTP状态，禁止记录含凭据的URL/异常全文；循环中每次成功结果落盘，后续429保留已得结果。`map-credential-rotation-required.json`为`rotation_required`时联网前拒绝，不能换脚本绕过。批次导入缺前置成功工件、工件失败或早于导出时拒绝写入。
5. **案例**：正确采用原文“县西巷86号”等文字地址并保留位置待核。基础兼容为无图无scope主体仍可走补图请求，隔离回调须报告实测前后6次、真实入队0。错误做法是把“新秀炸鸡”的无锡候选、经二路另一门牌或原图0张当作定位/媒体验收。
6. **验证**：`preview-food-address.py`覆盖6源12提及/1全文的真实SQL、幂等及逆序回滚；`verify-food-address-data.mts`核对事实、旧ID、范围及日期；消费测试保全实际图库返回。`test-map-probe-safety.py`用假凭据验证异常脱敏、部分结果保存及联网前门禁，全程离线。
7. **错误与正确补证**：第51批前置命令参数顺序错误且编排继续导入，不能事后补写“前置成功”。`verify-food-address-import-audit.mts`核对真实事务before_state与冻结库：5个整城表及地点/关系导入记录完全相同，其他导入记录另核现状；行程以元数据01既有摘要核验。`check-batch-state.mts after <batch> --audit-baseline`仅用于已具此补证的事后核对。未来新导入仍必须通过正常前置检查。

## 41. 同名餐饮的多位置推荐

- 完整原文已明确一个店名对应多个位置时，裸名不能自动归入已有坐标指向的门店。第52批秦记火烧：note2585明确铜元局前街，两次抽取保留为同一篇来源；note2602“肉火烧去制锦市，其他去河边”混合多个位置、note2856只给裸名，两者均null待审。不能据餐品建议拆造原提及、替作者指定分店，或发明具名分店实体。
- 对现有源执行完整`apply_scope_decision`，保存所有4条分配、原sourceHash及实体revision1→2。只消费已确认2条的推荐与内容，不修改原名、ID、原始记录或未核实的原位置；位置保留不等于新定位通过。剩余分店待审与整体媒体验收分别记录。
- 单源scope的指纹位于`place_identity_scope.source_hash`，`place_identity_scope_source`只在显式联合来源时有成员；不能把该表0行当作来源缺失。审计JSON中的PostgreSQL bigint来源ID可以是字符串，比较边界时显式转换已知安全范围内的ID，不能改写原审计。
- 验证须证明混合分店建议从简介、看点、理由、语料和实际placeFacts移除，明确来源内容及observedAt保持；有效提及4→2、现行分配增加4、待审增加2。旧同名引用继续指向现有稳定ID，但未经确认的“制锦市店/河边店”等名称和旧ID组合不能被解析为已确认别名。
- 无图普通主体新增scope后，实际图库仍可为空，而补图回调从1次变0：这是已有受控媒体回退门禁，不是新完成图像审核。保留前后真实返回、mock回调和真实入队0；其他主体图库3/1与全部旧字段保持。第52批已按`before <batch>`顺序正常完成前置检查与双同步，不使用第51批事后补证分支。

## 42. 恢复原始分店名与观点无关的范围分配

- 原始提及有完整分店名、正文有同分店限定时，可在完整scope后恢复该原名。第53批鑫龙火锅恢复“鑫龙火锅（北园大街店）”、七九刘家烧烤恢复“七九刘家烧烤(纬九路店)”；不自行补造新分店。先scope使实体1→2，再改名使2→3；原始源、地点主键、旧裸名别名及原地址坐标保持，位置未新验证。
- 分配依据是分店证据。鑫龙11709确认，11708投诉、12846口味分歧及12890正向裸名推荐都因缺分店限定待审；不能按评价正负筛选，原始评价全文继续保存。七九11635/12886分别来自两篇，均明确纬九路。有效描述由已确认提及重建，原文中的主观“最正宗”不升级为客观排名。
- 改名沿现有`apply_decision`为新规范名增加可认领的`legacy_id`，`identity.memberIds`因此可增加，但根ID不变且没有新实体。隔离测试应核对旧ID集合加合法新名称ID，不能错误断言memberIds完全不变；倒序回滚须恢复原集合。
- 专项验证覆盖新旧名SQL命中、全部memberIds、其他分店及“店旁”拒绝、未来新提及待审、来源日期、原输入、幂等和倒序回滚。受控导出可以恢复普通聚合遗漏的原结构化菜品看点，不能要求新内容等于旧的不完整简介。改名改变嵌入输入时须回填并实测向量。
- 新scope前后两店实际图库均为空，mock补图回调2→0，真实入队0；这不构成图片验收。照片、定位尚未核实时台账仍为部分核查，不能增加完整自查数。以商店名导航到雕塑/天桥的摄影路线另核主体粒度，不机械套用本批餐饮消费证据。

## 43. 明确分店作为摄影导航参照

- 摄影路线中的具名商店可以确认分店身份，但店名后的“打卡雕塑/天桥”不证明商店与装置为同一主体。第54批保留喜茶11344、山耶云耶11346两个有效提及，恢复原始老商埠分店名；全部描述只谈装置，没有独立饮品或店内体验，故用既有`subject_mismatch`隔离reason/evidence_text/place_content三字段。原摄影线索、完整正文和原始结构化看点保留，装置位置/归属待核，不猜“店旁”或新建摄影实体。
- 身份与事实状态分开：确认商店分店不等于确认装置事实，也不必为阻断装置描述将真实商店整项撤回。无可保留描述时允许空intro/highlights/topReasons和0语料，继续保留cafe/美食、有效提及及旧ID。完整scope同时使未来新提及待审，原文变化仍使现行分配失效。
- 精确坐标缺证据但旧点明显不在原文街区时，清除旧点并保留原文支持的概略地址。第54批喜茶旧恒隆地址与老商埠分店冲突；两旧点离现行街区参考点约2.72/8.53km，公开文字另确认经三/经四及纬三/纬四围合范围。距离只说明明显偏离，不能作为新店址定位；不借商埠中心点、经四路333号或另一门店落点。两店写概略“融汇济南老商埠”、lat/lng=null、unresolvable，精确位置仍待核。
- 验证旧消费必须分字段核实。第54批旧intro/highlights已经为空、research_evidence已经0条，装置文字实际位于topReasons；应断言旧topReasons确实存在且新值清空，并用原始placeContent及有效投影证明受控后不再生成装置看点。不能声称删除原本不存在的旧简介或语料，也不能仅删存在断言来掩盖夹具假设错误。
- 本批原2源/2提及/1全文、旧278分配保持，总280分配，112待审不增加；4SQL/2真实向量/30名称与ID边界、实际placeFacts、双导入和倒序回滚均单独验证。两店图库前后null、mock2→0、真实入队0；旧老商埠3图/经三路1图保持，不能据元数据保全宣称图片通过。

## 44. 同义名称治理与旧图库请求名

- `createGenerationPhotoLookup(city, identityLoader, dependencies)`的未绑定旧图回退仍按传入名称检索；身份能解析为同一主体，不保证任意新别名直接查图都有旧图。第55批初案把故居主名改为“济南老舍纪念馆”，实际导入后旧名有2图、新主名0图，因此初案未应用。最终`batch-55-v2`保留“老舍故居”主名，仅补两个纪念馆别名；调用者先用`index.resolve(city, name)`得到`resolved.place.name`再查图时三个入口均保持2图。直接用新增别名查旧图库仍为0，不能宣称新增媒体覆盖。
- `mentionSources`存在会禁止未审核旧图回退。故居新加scope的内存预演使2图变0，因此本批不加故居scope，不自动绑定11个独立来源中2个eligible候选，不扩展生产图片别名规则。故居3条普通提及和原描述保留；“从五龙潭南门出500米”的两条抽取起点有歧义，登记为未应用文字发现，不能将别名/门牌补充报告为距离问题已修复。
- 同一句文字可指室内展陈或户外墙面。note2817和补充全文2570明确西更道街5号主题墙；纪念馆同名展览不构成合并依据。主题墙完整scope保留12694，主名补“主题墙”、细类改`photo_spot`，保留文化粗类，清除与南新街故居完全相同的旧点。未知新点为null/unresolvable，不借街道点位；故居旧点保持但未新验证。百科正文支持南新街58号，成功抓取的日报文章不含该门牌，不能标为官方地址核验。
- 隔离普通导出必须带入`PlaceSummary.top_reasons`和实际adcode。旧冻结器只带count/score会产生空topReasons，是夹具遗漏而非治理删文。补充只读冻结并用`select(PlaceSummary).where(PlaceSummary.canonical_place_id == sid)`加载；`canonical_place_id`不是该表主键，不能用`session.get(PlaceSummary, sid)`。回滚应比对补充字段，原始冻结工件保持不改。
- 部分SQL重建导出的关系revision1不能导入已冻结全城revision28的数据库；来源版本门禁必须拒绝。局部媒体预演只重建所需旧地点/语料/绑定，并明确`partialCityImport:true`，最终仍需全城同版本地点和关系双导入、幂等与倒序回滚，不降低revision门禁。
- 验证入口为`verify-laoshe-data.mts`与`verify-laoshe-consumption.test.mts`；后者必须由`run-tests.mjs`注入隔离库。断言故居revision2/3成员ID/3普通提及/3语料、墙revision3/2成员ID/1scope提及/1语料；内容和来源日期保持，仅compiledAt可刷新。实库验证281累计分配、112待审、5SQL/2真实向量/35名称与ID边界；媒体实际返回3/1/2图保持，墙null、主流程mock1→0，新别名直接探针另计2次mock、真实入队0。图片比对仍暂缓，完整自查新增0。

## 45. 完整scope后的类别保持与历史位置继承

- 普通导出可能由`theme_tags`推导粗类别，而完整scope的`independent_scoped_place`不继续消费旧主题缓存。新scope前后必须比较`category`；即使目标不是改类别，也须在原文支持时以实体`overrides.category`显式保留正确类别。第56批初案导出把“济南环城公园”由自然变文化，v2增加`category:自然`决定，scope后版本1→2→3，原坐标和attraction保持；不是把公园改成新类别，也不能为保类别重新启用全部旧缓存。
- 跨地点路线时长仍用`factExclusions.visit_duration={reason:'group_duration',quote}`。note2823开头同时点名环城公园与珍珠泉并说“最快乐的两个小时”，12591的120分钟不能当环城公园独立时长。完整scope只删除分钟，原观泉/接水/蔷薇描述、2条看点、推荐理由与来源日期保持；缺少独立时长时导出未知，不填估计值。珍珠泉与黑虎泉等保持独立，不能因路径相邻合并。
- 任何位置变更以现行实体override为起点。原始源和早期台账是历史证据，不是当前消费值。第56批关帝庙原源仍为仲宫，但第30批已经修正为筐市街18-3并同步；本批继承revision2及其点位，scope2→3、更名“共青团路关帝庙”3→4。review35也已记录revision2；应区分原始冻结的revision1与台账现行版本，不能误报台账漂移、重新清点、覆盖正确坐标或重复计算新增定位。
- `mentionSources`仅声明`mentionId/noteId/inputHash`，不承诺`sentiment`字段。正负评价同等参与身份确认；以原提及、有效投影及最终`research_evidence.kind='xhs_warning'`验证负评保持。第56批四窟万象11492“票价略贵”和12777正评均确认；不得将负评待审或删除以净化评价。正文明确千佛山范围，城西旧点清除但不借山体中心定位洞口，主名和文化/attraction不变。
- 专项验证使用`preview-park-culture-v2.py`、`verify-park-culture-data.mts`与`verify-park-culture-consumption.test.mts`：3源4提及/4全文、1分钟排除、全部描述/语料日期、既有关帝庙位置、幂等/倒序回滚、285累计分配/112待审、4SQL/3真实向量/35边界以及实际placeFacts。导入前后图库3/1/2保持，3目标无图、mock3→0、真实入队0。台账部分scope与完整审核必须分开，媒体暂缓不增加完整自查数。

## 46. 正文分店限定与实际语料基线

- 原抽取名为裸名，但完整正文连续出现道路限定名时，可以采用该原文形式具体化现有主体。第57批为“燕喜堂（CBD店）”“刘小忙把子肉（联四路）”“亮亮拉面（经十一路）”；后两者不自行加“店”，不宣称是官方分店名。稳定根ID及旧裸名保持，新规范名只增加合法成员ID，不新建或合并主体。
- 分店scope必须覆盖全部匹配提及。燕喜堂11537/12863明确CBD，12798路线相似但只有裸名，继续待审；刘小忙11644明确联四路、11525泛指品牌；亮亮11676明确经十一路、11481/12741是同篇裸名重复抽取，不能成为两份独立分店证据。4确认/4待审，正负观点不影响归属标准，原始评价完整保留。
- 清点位的表述须符合证据强度。三店旧点未有明确分店依据，燕喜堂旧金菊巷地址另与CBD冲突；采用原文CBD/联四路/经十一路概略地址，null/unresolvable，不声称已查明三个旧点各属哪家店。高德/点评搜索摘要虽给地址坐标，fetch正文为空时仍不得采用；小纬十一路、经六路也不是经十一路。精确位置继续待核。
- 普通历史语料不一定逐提及保存。三店旧research_evidence分别1/1/2条，而原提及为3/2/3；验证须读取真实冻结基线，不以原提及数推定旧语料条数。scope后燕喜堂菜品结构化看点恢复，路线理由保存在语料、未成为展示看点，分别检查相应字段。刘/亮已确认道路描述及observedAt保持，待审泛指描述从实际消费中移除。
- 新明确名称可能恢复合法关系：第57批note2830“燕喜堂（CBD店）→山东博物馆”产生一条weak、单篇关联，18→19，direct仍3。核验全文偏移、两端提及及原18条逐条保持；不能预设新增待审只会减边，也不能把该关联当距离或先后排程约束。
- 验证入口为`preview-restaurant-branches.py`、`verify-restaurant-branches-data.mts`和`verify-restaurant-branches-consumption.test.mts`：3源8提及/6全文，幂等/倒序回滚、全城双导入、293累计分配/116待审、6SQL/3真实向量/27边界、实际placeFacts，117旧图片字段/9绑定/201行程保持。旧图库3/1/2保持、三店前后null、mock3→0、真实队列0；不看图、不将部分scope和位置清空计为完整自查。

## 47. 普通来源图片提示与只读核查

- 普通地点仍可能按全城图片文字包含地名取得`tips`；提及正文正确、营业主语校验正常都不能证明提示正确。第58批护城河2条正文路线提及有效，但旧tips来自note2810第5图“解放阁 / 济南解放纪念馆”，含“为纪念济南解放而建”“登阁可看展览”。护城河仅是被俯瞰景物，不能继承纪念馆描述。检查当前导出时须包含price/tips，不能只核intro/highlights。
- 用现有完整scope保留全部2条提及，阻止普通全城图片回退；无错误原提及字段时不伪造factExclusions，不修改原图文或新增无意义实体决定。仅1个scope使revision1→2，原名/ID/文化类别、位置、两条描述与语料保持，tips消失，旧混合主题不再消费。游船/船站票价与预约原本未进入河道当前字段，不报告为本次删除。
- 隔离预演须带入额外图片事实RawNote及完整摘要字段，先真实导出复现错误tips，再应用scope验证移除及倒序回滚；不能仅验证无污染输入下结果为空。`preview-river.py`保全11篇补充图片文字来源；实际库另逐字段确认这些RawNote保持。
- 不需要业务修订的主体只做只读核查。第58批另核东更道、珍池街、双忠祠街、西公界街、华山湖公园，5源9提及/2全文保持原revision1和普通消费，不为推进统计添加scope。身份/当前事实已核，但位置和媒体未完成时记录`reviewed_identity_media_location_pending`，不增加完整自查数。
- `verify-batch.mts`按实体决定选择SQL/向量探针；纯scope批次可能返回0探针，即使failures为空也不证明检索通过。`verify-river-outdoors-data.mts`明确对6主体执行6SQL/6真实向量/38名称与ID边界；累计295分配、116待审。`placeFacts.toFacts`不消费tips，本次修正知识payload，不能声称修复调度中的历史提示；消费测试另核类别、位置、有效提及和旧图库。
- 六主体实际无图，完整城市导入后mock补图6→5，只有河道新增scope抑制回退；五普通主体保持。老商埠3图/经三路1图/老舍故居2图以及126旧图片字段/9绑定/201行程保持；未查看原图。
- 搬迁证据须区分到访/发表/采集时间。环联夜市原文1469号对应2022报道旧址，2025正文回顾2023东迁西周；2026采集时间不能证明原文是新址。搜索主回答与抓取正文冲突时弃用主回答，网页推荐区日期不能当文章日期。现点未核时登记历史位置补证，不自动清点、合并或认领新址。

## 48. 持续经营主体迁址与旧导航消费

- 同一经营市场的迁址和更名可保留稳定实体ID，但须有正文支持连续性。第59批2023开业公告及2025回顾支持环联夜市东迁西周、改名“环联1904火车夜市”、地址“祝舜路555号”；保留旧名别名，只增加一个合法成员ID。仅地址有依据时只改address，当前坐标未被证明错误则保留待核，不因历史搬迁自动清点或借新址街区中心定位。
- 时间证据分层：RawNote.publish_time须与raw_json.note_card.time核对，last_update_time与created_at另记。发表晚于搬迁不能证明到访晚于搬迁；2026发表笔记仍含1469号旧导航，应按正文冲突处理。补充发表信息不改load_mention_rows使用created_at的既有observed_at或历史指纹，实库验证发表/采集时间及完整raw_json散列保持。
- 主体身份可辨与当前事实可用分开。11464明确市场，但同时含旧门牌和交通看点，现合同按整条提及待审，原始正评与正文保留；不伪造“身份未知”、不新增无合同的时间factExclusions。其他四条无矛盾旧址事实的普通规模/拥挤/交通观点保留，不用于验证精确位置。三条负评继续为xhs_warning，同篇两个抽取不成为独立来源。
- 更名时openHours.subject随规范名更新是合法主体标签变化；目标其余营业字段仍须逐项相等，其他主体完全保持。第59批unknown营业内容未改，验证应只允许subject变化，不能放宽整块字段或称营业时间被修正。实际旧看点3→1、语料5→4分别核验；保留看点及observedAt保持，旧导航和整条待审推荐退出当前消费。
- 使用preview-night-market.py、verify-night-market-data.mts、verify-night-market-times.py和verify-night-market-consumption.test.mts验证：完整5分配/4确认/1待审、幂等/逆序回滚、累计300分配/117待审、2SQL/1真实向量/21边界、双导入和实际placeFacts。19关系证据保持，10个独立媒体来源均不eligible、无认领，实际新旧名均null，mock1→0、真实队列0；老商埠3图/经三路1图/老舍故居2图保持，未看图、不增加完整自查数。

## 49. 裸名餐饮品牌撤回与候选门店

- 多门店品牌的菜品体验不能凭旧坐标归入单店。第60批超意兴三篇只写品牌；春水锅贴有五龙潭公园店、大明湖店两个公开正文候选，“最近一家”和未指明目的地的搜索地图文字不能择一；草包同篇两次提及没有普利街/千佛山东路限定。完整scope全null保留待审，显式撤回旧单店消费，不改原始记录，不用not_a_place，不创建仅由网页候选拼出的门店。
- 无有效确认提及且无确认候选时，withdrawn_place导出category=其他、无xhsPlaceType/内容/语料/坐标，identityWithdrawal.reason=unavailable_source、candidateIds=[]。这里表示当前缺可用身份分配，不等于停业、私密来源或不存在。上游实体记录仍可保持ACTIVE，实际可用性由scope导出契约表达。测试应区分原始餐饮类型与撤回占位行，不为保留food字段改生产契约。
- 同类菜名、相同“20年”宣传语不能独立证明门店相同。天天过年11375明确济南西旁边，可在原名/ID下保留西部主体提及；12806仅裸名及类似菜单待审。地址只写原文概略济南西周边，清旧梁庄点，不把未抓取成功的点评门牌或同名临沂店当定位，不发明官方分店名。
- 历史门牌补证与当前定位分开。陈氏肥蛤2018公开文字支持经七路423-2号历史地址，可以保留现值并记录只读核查，不宣称2026营业或精确点已核，也不据未搜到其他分店证明全城唯一。草包1937只有未抓取成功的摘要时不得据此裁定“百年”错误；全条待审移除该描述，不等于完成年代事实核查。
- 第60批4源10提及/5全文正式范围，另陈氏1源2提及/2全文只读；310累计分配/126待审。5SQL与5真实向量中明确区分2个有效命中、3个撤回不命中，30边界和三新增撤回的历史行程持久化/编辑拒绝验证。实际placeFacts、图库、幂等/逆序回滚与19条关系保全分别留证；mock5→1、真实队列0、旧3/1/2图库保持。三个撤回的空坐标单列，不混作已解决定位或完整自查。

## 50. 通用墙名提示、原路线主体与购物品牌分店

- 通用“济南文字墙”名称不能把不同路线的墙面提示汇总为同一地点。第61批12688确认的范围仅为note2817第②站原始主体；第③站月下观棠附近几面白底书法墙与note2566老商埠喜艾店旁墙不自动归入该主体。完整scope停止两条旧图片文字提示消费，保持原看点/日期、文化/photo_spot与第30批空点，不宣称具体墙面已辨认，也不新建别名或重复清点。
- 普通和受控导出对短reason的语料过滤可能不同。第61批旧普通“热门拍照打卡点”未成语料，scope后保留为一条已确认原reason。检查应分别验证两个路径及原字面值，不能要求语料数机械相同，也不能仅因数目改变而修改生产过滤器。看点、日期、tips及实际placeFacts仍各自核验。
- 商店品牌与餐饮品牌遵循相同分店门槛。note2573同时列淘子外单三店但未指明到访门店，路线近邻不选择分店；唯一11536待审、旧单店消费显式撤回，保留原名/ID/原始经历，不标非地点、不创建网页候选。撤回导致的空坐标不计作精确定位或新清点完成。
- 搜索成功状态、DIY文字、商户括号或酒店门牌均不能独立解决具体主体粒度。山东大厦官网只补证现有酒店地址，中庭精确点及开放许可另核；月下观棠、夹心胡同与附近墙/装置边界未明时保留待核，不因类别猜测而改shop。明珠天地C的疑似错字也须同体证据，不能采用搜索假设或不相干建筑。
- 第61批正式2源2提及/2全文，另5主体只读待核；312累计分配/127待审、7SQL/7真实向量（6正1撤回）/42边界通过。原源与日期、19关系、幂等/逆序回滚、历史引用及实际图库分别验证。mock7→5、真实队列0、旧3/1/2图库保持；98行仍76未完成，完整自查新增0。

## 51. 街道类别、独立停留与混合提示中的有效意见

- 公共历史商业街的餐饮活动不把街道变成单一餐饮店。第62批芙蓉街由美食/food改文化/other，完整继承第30批已纠正地址与点位；后宰门街维持文化、细类改other。腊山河廊道只由文化改自然、保留attraction和未新验证的原点，不借南延工程标题指定廊道段。粗类、细类、位置和事实核查分别报告。
- 原文明确“16:00–16:30 后宰门街，拍济南府大字墙”支持街道停留30分钟；摄影目的不自动把路线主体改成墙面，也不因邻段另有街道而排除独立时段。11460/12726同篇同分钟只算一个独立样本，12690保留另一篇的簪花文字墙看点。完整scope确认3条，不合并墙名、不宣称墙面已定位。
- 清洗混合提示须核对有效意见损失。芙蓉街旧tips混入博物馆闭馆及黑虎泉信息，但note2568既有图片文字分析确有“别在芙蓉街买小吃，又贵又不正宗”的作者意见。现有scope将整体停止未归属图片提示，且没有已确认提及承接该意见；不能仅保留原始存档就宣称消费无损，也不能伪造tips override或原始提及。第62批仅改类别，保持现有正负评价、tips和30分钟，12904/12948未具名餐馆描述与提示净化登记未应用，等待可保留有效意见的治理方案。读取既有分析文字不等于查看图片。
- 油旋张两篇全文三条提及均无分店限定。历史食记的纬三路与大观园候选只补证分店歧义；另一笔记地图搜索中的顺带店名不能认领。完整scope全null、旧单店显式撤回，原名/ID/原始推荐保留。撤回占位的空坐标另计，不记作清错点或精确定位。
- 混合批次可以同时包含普通实体类别修订与另一主体的scope。`validateScopeExpectations`仅允许有本批实体决定、verified=true且不在scope受影响集合中的普通主体省略mentionIds；受控主体仍必须显式列出。`validateBatchExport`继续拒绝以普通预期漏验mentionSources，不能修改冻结预期或虚构scope来迁就预检查。同步契约七项回归覆盖未知主体、无提及撤回、受控提及遗漏和历史兼容。
- 通用`verify-batch`的vector_first探针只适用于有效主体。撤回应在专项探针断言不命中；误把撤回ID传入正例检查时保留失败工件，另以带标签的正例报告与撤回排除报告核验，不重放业务决定。第62批5SQL/5真实向量（4正1撤回）/30边界通过，关系仅两处芙蓉街端点版本更新，证据、位置与强度保持。

## 52. 既有分析中的原文警示与共同来源版本

- 完整scope可选`textWarnings`，存可空`PlaceIdentityScope.text_warnings` JSONB。每项严格为`noteId/imageIndex/start/end/quote/entityId/inputHash`；imageIndex为既有RawNote.img_analysis零起始索引，只引用text_content完整单行，8–500 Unicode码点，禁止剪裁否定、跨行拼接或替换。目标须已有本scope确认分配并为ACTIVE根，不伪造PlaceMention；后续合法合并按根消费，保留原句。
- 指纹覆盖笔记ID/城市/标题/正文/可用性、选中分析文字/索引及发表采集日期，不包含滚动签名URL。仅将原句加入tips与xhs_warning，不增加提及数、推荐分、看点、时长、营业/预约或路线端点。原文变化、缺失、删除/私密时拒绝消费和导出，要求重新审核或显式移除；不能静默用新文字替换旧意见。
- 已有警示的scope更新必须显式给出完整列表，`[]`表示移除，显式null拒绝。审计输入覆盖旧/新警示笔记的并集，包括被移除项，来源变动后的倒序回滚拒绝；旧null字段省略以兼容原快照，恢复旧scope时明确还原null。幂等迁移只加可空列，核对旧原始/派生/治理表与完整审计摘要保持。
- relation sourceState可选非空`supplementalSources: [{scopePlaceId,inputHash,assignmentHash}]`，纳入当前补充文字和完整审核分配散列；无警示则完全省略。下游要求正scope ID、合法散列、scope唯一，沿既有sourceHash联结地点与关系版本，不建立额外关系。实际双导入须覆盖警示保全、显式清空、幂等、旧文件拒绝及逆序回滚；上游另测来源变动、负面句完整性、迁移和合并后保全。
- 第63批芙蓉街30提及28确认/2未具名餐馆待审，11699仅排除酒店位置评价字段，独立两篇30分钟保持。note2568的“美食：别在芙蓉街买小吃，又贵又不正宗！”以新协议保全，停止全城混合tips及博物馆闭馆review注记消费，openHours仍unknown。原4看点/日期和5有效语料保持，受控语料重建27条。11689年代说法仅为带原文的社区作者表述，公共商业街史不独立证明百年餐饮经营；无反证时不伪造subject_mismatch年代排除。
- 完整scope可使已确认提及的关系位置失效。note2851的12835/12836仍resolved，但引文不能定位多次地名中的路线74–77端点，芙蓉街—宽厚里弱关联因ambiguous_text_occurrence移除；不得归因于另两条餐馆待审或补充警示。其余18条关系证据保持，芙蓉街—曲水亭街仅端点版本变化，direct仍3。
- 第63批以真实资料隔离复现旧混合提示、幂等/回滚，全城双导入、1SQL/1真实向量/16边界、348累计分配、实际placeFacts与图库分别验证。部分重建旧tips1条，实城旧tips2条，不混用基线数量。238旧行/156旧图片字段/9绑定/201行程保持；旧3/1/2图库、芙蓉街null与mock1→0均只证明消费返回，不等于视觉验收。天地图凭据待轮换时测试明确排除live map，不把被排除项报为通过。

## 53. 地址限定门店、只读地址疑问与重复来源

- 原文地址和已抓取商户正文可以共同限定已有门店，不自动证明更多分店。第64批许记排骨使用“许记排骨（县东巷71号）”地址限定展示名，保留稳定ID和裸名别名，不冒充官方“县东巷店”。11353/12594同篇明确门牌，12893另一篇只有裸名而保留待审；不能因没找到别店便认定全城唯一，也不能把待审说成已经证明存在第二店。
- 桥下把子肉的2026-04-15济南文旅正文明确山大南路店、山大南路蜀易火锅隔壁，与两篇原文一致；蜗牛叔叔的食堂的Trip正文明确泉城路店和狮子口街参照。三店完整scope共8分配/7确认/1待审，原有效推荐保留；桥下更正为原文和公开正文共同支持的概略地址，蜗牛旧地址保持待核。旧评论不证明当前营业，未知营业内容只随规范名更新subject。
- 地址修订与精确定位分开。许记旧空地址点在原文“大明湖/泉城路附近”参照西侧约4–5km，清除不支持县东巷71号的旧点并保留门牌，精确位置仍待核；参照距离不作为县东巷精确边界或新点。高德空正文抓取的坐标摘要不能采用。桥下和蜗牛的当前点未有新反证时保持，不能因新增scope或缺POI ID而自动清空。
- 华祥原文“大观园南门西行100米路北”、历史文章“经五路东首”和Trip经五路店“饮虎池街回民小区24号楼”尚无同店连续性证明，保持原主体和消费待核，不强行合并或认定迁址。历史文章永长街25号属于另一商号穆香斋，不能串店借址。
- 同篇相同reason和sourceUrl在受控导出中去重。第64批7条确认提及输出4条语料、4条看点；许记待审裸名的看点及语料退出当前消费，确认来源的字面评价和日期保持。测试不能机械要求语料数等于提及数。隔离重建必须保留原note_images的null/数组形态以匹配指纹；汇总展示用`or []`不意味着可以把原null写回为空数组，scope旧null警示在目录中省略也应按合同检查。
- 第64批真实4源10提及/3全文，治理3源、华祥只读；幂等/倒序回滚、全城双导入、7SQL/4真实向量/66边界及实际placeFacts/图库分别留证。18关系及既有芙蓉街警示来源保持，356累计分配/133待审；238旧行、159旧图片字段、9独立绑定和201历史行程保持。159含历史空字段，不代表新增图片；四店前后无图、mock4→1、真实队列0，媒体和精确位置仍未验收。

## 54. 门洞摄影主体、经营场所裸名与导航参照

- 原文明确“起凤桥八号”门洞摄影时，可将该现有主体限定为“起凤桥八号门洞”，不推定整个院落或经营场所同义。第65批5392完整scope确认11458/12724，新名为唯一别名，`excludeNames:["起凤桥八号"]`；稳定根ID、原始名称及历史引用保留。公开历史食记存在“起凤桥8号”餐饮用法，只支持裸名含义不宜直接等同门洞，不证明2026经营状态、院落与餐厅连续性或精确点位。
- 独立14:30–15:00时段支持30分钟，两个抽取均来自note2570，只算一个独立样本，不加成60分钟。原1条看点及日期、2条不同reason语料均保留；相同URL不意味着不同reason应合并。保持文化/photo_spot、旧地址“起凤桥街8”和原点，位置未新验证，不新增实体、撤回或事实排除。
- 路线标题为起凤桥、导航写八号，不足以将桥体、门洞、街道、院落视为同体。起凤桥7条原提及继续只读，保留“人多，可改拍西侧灯笼亭子”的意见；亭子为替代机位，不能吞并为桥或门洞。历史review375的part_of审核保持，旧街道参考点未被重新验证为实体桥位，不借百科片名、冲突方位或坐标补事实。
- 名称排除与媒体回退门禁分别验证。新门洞主名为scope引用，实际图库null且不回调补图；旧裸名连同旧ID不得解析为门洞，但被排除后也不再是`isScopedReference`，直接按旧名请求仍走未知名称普通回退。本批规范名路径mock2→1（仅桥），额外旧裸名探针1次，总2次，真实入队0；不能把混合新旧入口的2次误报为只有1次，也不能将未知名称回退报告为门洞已获媒体许可。
- 第65批2源9提及/6全文，1源scope、另1源只读；幂等/倒序回滚、全城双导入、2SQL/2真实向量/35名称与ID边界、2餐饮排除及实际placeFacts/图库分别留证。358累计分配/133待审、18关系/direct3和芙蓉街警示来源保持，6篇原日期/raw_json及2813原null分析保持。238旧行/168旧图片字段/9绑定/201行程、旧图库3/1/2保持；168含历史空字段，不代表新增照片。媒体暂缓和位置待核时仅记部分scope，完整自查不增加。

## 55. 园内分区限定、错区坐标与跨城同步日期

- 完整正文明确园区语境时，可给原分区名附加园区限定，不冒充官方名称。第66批“萌宠片区（黄龙溪欢乐田园）”“龙溪谷大型野趣戏水区（黄龙溪欢乐田园）”各确认1提及，保留原根ID，revision1→3。通用“萌宠片区”排除；原完整专名“龙溪谷大型野趣戏水区”仍为合法别名，但不增加“龙溪”“龙溪谷”短名。公开旧游记的鹿溪牧场不能直接证明萌宠片区与其严格同义。
- 旧点误落新都商店、都江堰龙溪时，同时清除lat/lng和旧adcode，地址仅保留“黄龙溪欢乐田园内”，geoStatus为unresolvable。不能借园区主点定位分区，不能仅清坐标而把错误行政区继续交给调度。实库为null坐标；placeFacts只在经纬度均为数字时输出坐标，未知位置和空adcode在消费对象中为undefined，分别按各层合同断言。
- 同篇游记的半小时属于太阳鸟剧场，不向萌宠区或戏水区传播；两区独立时长保持未知。原看点、reason和作者“水浅安全”等体验保留为来源意见，不扩成一般安全保证。原文化/attraction仅为兼容值保持，类别尚未完整核查。园区本体保持独立、只读，其历史教师优惠、98元和09–18记录不作为本轮核实事实，也不向分区继承。
- 切换城市前分别冻结实际下游库和当前生产者导出。历史日期修复可能已安装而尚未同步该城；第66批成都245主体314看点的observedAt从旧导出时间恢复到原RawNote.created_at。逐条核对上游日期及来源，除日期与compiledAt外内容保持，原笔记日期/raw_json/分析不得改写。这是既有元数据修复的城市同步，不新增实体治理协议，不把日期变化错判为本批主体污染。
- 成都完整基线为113重点主体＋3依赖/127原源、490提及、85笔记；依赖单列，历史局部审核不等于全维度通过。第66批3源3提及/2全文，2源治理、园区只读；幂等/倒序回滚、392地点双导入、3SQL/2真实向量/42名称与ID边界、49关系/direct15及201行程保持。全城372旧主名实际查图返回逐项一致，11处各1图，两新名null且mock0，旧主名mock361→360，排除后的萌宠裸名仍走未知名称回退，真实队列0。121旧图片字段含117撤回行空字段，字段数不是图片数；未看图，完整自查新增0。

## 56. 通用市级点清理与地点范围待核

- 多个不同地点共用精确坐标、仅有市级地址和空POI ID，不足以证明具体位置。第67批四大会馆、一街七巷、真茶屋（天府广场店）、麻布食堂都为30.572961/104.066301、四川省成都市、510100；完整原文分别指向洛带会馆群/街巷和市区商户，清除不支持具体主体的点及adcode。未取得历史地理编码响应时，不能断定原始错误产生过程，更不能只因坐标重复就自动批量清点。
- 位置与身份治理可以分步。仅修位置时沿实体决定保持名称、别名、成员ID、类别、所有非位置消费、原scope和分配；不得为推进统计新建无必要scope。第67批四实体revision1→2，两个洛带对象地址仅“洛带古镇”，两店没有可靠门牌时清空泛地址。不借古镇、广场或商场中心点补坐标，不把空点报为精确定位完成。
- 四大会馆是四处会馆合称，一街七巷是街巷格局，不按单栋建筑核实，也不把各会馆或巷名全部认作同义别名。洛带古镇现行complex中的主街成员名、空components和主街提及聚合须独立核对；博客楼的周一提醒、原门牌、既有分析中的福建土楼描述分别保留待核。没有查看图片时，分析摘要不能独立证明图片身份错误。
- 商户标签不能自动成为分店名或店址。麻布食堂原文只有成都万象城标签，不能直接更名万象城店；真茶屋明确天府广场店也不能据分店名取得门牌。两次主搜索超时及中文补充源缺凭据须如实记为未获公开证据，不能采用不存在的搜索结论，仍可依据完整原文及现库字段修正已证实的无依据位置。
- 第67批6源12提及/5全文，4处位置修正、古镇和博客楼只读；隔离导出逐字段仅允许位置及revision变化，幂等/倒序回滚通过。392地点、49关系/direct15、41既有分配、127原源/490提及/85原笔记与原日期/分析散列保持；4SQL/4真实向量/40名称与ID边界及实际placeFacts通过。372现行主名查图返回一致，11处各1图，mock359→359、真实入队0。第66批按旧裸名的360次mock与本批现行名称集合不同，不能解释为本批又抑制一次回退。台账新增4项位置部分核查，完整自查不增加。

## 57. 公园类别、既有网页简介与跨行原评价

- 城市公共公园以园林、湖面和市民休闲为主体时可归自然/attraction；园内纪念碑与茶社不把整园改成单一文化建筑或餐饮店。第68批人民公园仅将文化改自然，保留原点、名字、别名、120分钟及全部简介/观点。类别修正不代表范围、时长样本、营业或媒体已经完整通过。
- 名称未改的实体决定也可能补登记既有别名的历史hash ID。`apply_decision`会对全部现有别名调用`can_claim_id`，第68批登记成都人民公园、祠堂街人民公园两个此前未占用的ID，原稳定ID保留，无新别名或合并。必须核对上游全局占用/历史创建、下游旧行及名称+ID边界，不能误报memberIds完全相同，也不把兼容登记当成对存疑别名的再次确认。
- 完整scope会让未绑定当前身份/版本的旧网页profile失效。人民公园原有web_research_with_model_knowledge及3条网页引文看点，隔离假设scope确实将其替换；原始存档保持不等于消费保持。先解决有效网页内容、已有意见和媒体保全，再应用3771合游120分钟排除与3831路线标题待审/别名排除。隔离中用于复现损失的全确认分配不是业务决定，不得直接应用实库。
- 原始分析“可以不去\n鹤鸣茶社”跨行，不能用只支持完整单行的textWarnings伪造新句、丢掉否定词或用另篇“人挤人”替换作者观点。第68批茶社完整scope暂不应用，旧正反评价保持。note929计划2–3小时且后文仍有建议游玩2–3h，可记录为作者建议，不能称实际完成；茶社08:30–18:00的社区说法也不能作为公园营业时间。
- 专用查图返回null不证明其它消费没有图片。第68批人民公园专用lookup为空，但实际placeFacts仍有1条旧图库及封面；两路径分别断言。类别决定保全全部字段，完整scope会触发受控图片规则，因此在图片暂缓期间不能只根据lookup为空就给公园新增scope。
- 关系版本在边的fromRevision/toRevision与evidence端点的revision两层出现；后者不是entityRevision。第68批5条边、10处证据端点仅人民公园版本1→2，其余证据/位置/强度逐字段保持。392导出、3SQL/1真实向量/16边界、127原源/490提及/85原笔记、41分配、411旧行/127旧图片字段/201行程保持。初次旧撤回探针向量暂不可用，原失败文件保留，带retry01标签重测通过；不覆盖失败记录。台账只增类别部分1项，完整自查仍0。

## 58. 相邻两行原评价与完整scope保全

- 第69批扩展第52节的单行`textWarnings`校验：仍使用原七字段、`note_text_warning_v1`指纹和既有存储，允许恰好两行连续、完整、非空且无首尾空白的原文，其中至少一行经`name_key`严格等于本scope已确认ACTIVE主体的当前主名或别名。LF、CRLF、CR、U+2028、U+2029均保留原字符；不拼写新句，不更换来源，不新增数据迁移或下游协议。
- `validate_text_warnings`继续检查8–500字符、Unicode码点偏移、当前可用同城笔记、全文与日期指纹及当前主体。三行、空行、混合主体名称行、拆开主体名、剪掉否定词、正文中途截取、改字/换序和过期原文均拒绝。结构校验不判断评价是否真实或推荐是否合理，仍须逐条核对上下文；不能把作者观点升级为客观结论。
- 鹤鸣茶社六条提及全部确认，原四条正面看点及日期、两条负面评价和旧五条语料保留。新增note877既有分析中的`可以不去\n鹤鸣茶社`逐字警示，恢复旧短理由“老茶馆体验采耳”，最终七条语料/三条负评；混合tips替换为一条原跨行警示。原名、两别名、根ID及memberIds、简介、17.83推荐分/6提及、美食/cafe和旧位置保持，实体revision1→2，不将旧点报告为新核实。
- 公园和茶社分别核验。人民公园的网页profile、所有消费和facts旧1图/封面不变，茶社facts和专用lookup均无图。不得把公园/博物馆合游120分钟或公园站90分钟复制为茶社独立时长；独立时长缺失，营业和预约继续未知。茶社scope已修复不消除公园网页/原观点/旧媒体的保全约束。
- `sourceState.supplementalSources`新增补充原文引用并升全城来源版本9，但49条关系/direct15内容全等；补充评价不是路线边。审计snapshot的`scopes`只有place_id/city/name_keys/entity_ids/revision，不含完整textWarnings。原警示存储需从上游catalog严格对照决定，再核对全字段导出与SQL语料，不向摘要索引假设不存在的字段。
- 第69批真实1源6提及/6全文预演、幂等/倒序回滚、392地点双导入、2SQL/1真实向量/14边界通过。原127源/490提及/85笔记与日期/raw_json/分析保持，旧41分配加6为47；411旧行/127图片字段/201行程不变。372主名实际查图返回一致，11处各1图，mock359→358仅停止茶社补图，真实入队0；只核对返回与元数据，没有看图。上游716通过/1个真实地图检查排除，跨行协议实际双导入/移除/回滚通过。成都只增加1项部分scope，完整自查仍0。

## 59. 编号原评价、静态组合补名与研究检查点

- 第69批之后扩展双行主体标题识别：可接受1–999编号加明确分隔符`、.．)）`、当前主名或别名、可选1–3个常见图标字符及空白分隔的0–10评分（最多一位小数，可带“分”）。只在校验投影中剥离格式，完整原quote、偏移、日期指纹和`note_text_warning_v1`保持，无迁移。评分不能成为别名；混合名称、额外断言、否定前缀、缺分隔符及非法评分仍拒绝。结构校验通过不等于内容已获业务确认。
- 真实note948的`6、武侯祠 8.3`及`11、锦里古街🏮 7.2`连同下一整行评价通过已安装校验器；10项截断、改字、改日期和未确认主体变体被拒绝。原文包含的“可以去”“不太推荐专程去”及顺便游玩限定逐字保留，不用其他作者意见替代。合成编号夹具的数据库、双导入、移除、幂等、旧版本拒绝及逆序回滚另行通过，不能把夹具验证写成真实地点scope已应用。
- 武侯祠4031的150分钟来自含锦里收尾的整条路线；锦里4061的75分钟包含打车。两者均不能当独立停留时长，尤其不能因新增scope把旧导出没有的75分钟引入消费。武侯祠3818及锦里3822来源为住宿片区可达性，不能把片区生活氛围和抽取补出的古镇风当场所内事实。原提及、正文、正负观点、日期及历史教师优惠条件保留，排除须按字段、原quote和指纹正式预演。
- 锦里3702原名为锦里古街主巷，正文将其列作夜游路线一站。`IdentityCatalog.contract`不含主巷不保证最终导出也不含；内存预演已复现`consolidate_places`通过`planning_members`补回该名并保留空components。正式治理必须检查最终memberNames、别名、名称+ID入口及实际消费，不能仅写`identityExcludedNames`就声称母子边界修复。
- 武侯祠旧网页profile有3条web看点。未绑定profile确会在scope预演中被替换；匹配`scoped_binding`的profile可在内存逐字段保持，但技术上能够绑定不代表已审核来源或已授权直接改缓存。公开网页抓取失败不能冒充重新核实旧引文。官网08:30–18:30/17:30停止售票与票务页09:00–18:00/17:00停止入场存在时间和口径差异，后者还含旧疫情规则，不能拼成统一现行政策；搜索生成答案不替代原网页证据。
- 研究检查点与实体批次分开编号。此次2源43提及、27篇直接正文及补充948，成都review06仅补研究证据，实体69/flow71/audit68及47分配不变，完整自查仍0。两点实际facts与lookup均无图，假设scope前后null、mock2/真实队列0仅证明媒体预检；未生成真实业务scope或完成正式双同步。编号协议安装、真实原句验证和研究发现分别留证，原4项未应用发现保留并新增两点待治理，不虚报本批实体已变更。

## 60. 受控组合名称、含交通时长与关系位置歧义

- `consolidate_places`对v2完整scope主体只使用当前身份合同的memberNames，不从静态planning、静态别名和originalName补充未审核名称；未受控v2组合沿用原行为，但按name_key过滤identityExcludedNames。v1兼容行为保持，complex类型、独立子项导出及components中的事实/坐标不删，历史memberIds不删。该修复不要求迁移或新增协议字段。
- 名称排除门禁不能为解决静态补名而放宽。`validate_name_exclusions`要求被排除名的提及已确认属于本实体，待审/过期/其他主体提及仍拒绝。锦里3702应待审，不能先假确认再排除；第70批通过完整scope停止静态补名，未提交主巷excludeNames决定。原名/normalized_name及原笔记不改写，不新建独立主巷实体。
- 区分事实名称与检索子项名称。下游placeNames默认排除complex.memberNames，主巷原本就未借用母项placeFacts；`includeComponents=true`时此前仍可作为锦里的检索入口。本次实际断言前者前后均无主巷事实，后者在普通/旧根ID/兼容ID三个入口均退出。不能把元数据及检索入口修复报告成原事实已被污染。
- 第70批锦里17提及中16确认、主巷1待审；3822住宿片区reason/evidence_text按subject_mismatch排除，保留原文；4061的13:00–14:15含打车，按group_duration排除75分钟，原白天体验负评保持。当前导出与facts均无独立时长。细类attraction改market、文化粗类及旧点保持，旧点不称新核实。实体revision1→3，已存在的锦里古街别名补登记兼容hash ID，原根ID保留。
- 三条逐字原评价来自910/image5、902/image5和948/image2，后者保留编号/评分标题及整行评价。原7负评与6条旧观点语料、3条有效旧看点和日期保留；错误住宿片区看点退出，现18语料/10条警示。旧价格/预约派生片段的原分析与历史不删，不当作本轮现行政策已验证。936的额外锦里段仍保存在原分析，不剪裁新句也不声称其全文已经进入消费。
- 逐提及受控后，关系端点必须在原文唯一定位。武侯祠—锦里原4篇证据中的884/3961、912/4155、950/4209均各有2个同名位置且evidence不能唯一指向，按既有ambiguous_text_occurrence规则退出；仅945证据保留，关系由direct降weak。49条关系总数不变，direct15→14，关系/来源版本10；不是主巷待审直接删除3条关系，也不将原观点从语料删除。武侯祠的原网页profile、150分钟及全部消费保持待后续治理。
- 本批2源43提及/28正文真实重建、幂等/倒序回滚与实库事务预演通过；392地点双同步、2SQL/1真实向量/21常规边界及3子项检索边界通过。127源/490提及、85原笔记加补充948共86篇及日期/raw_json/分析保持，47旧分配加17为64。411旧行/130旧图片字段/201行程保持；130含第69批新增的茶社空媒体字段，不代表新增3张照片。372主名图片实际返回全等，11处各1图，mock358→357仅停止锦里补图，主巷未知名称额外mock1，真实队列0。上游752通过/1真实地图检查排除；成都新增1项部分scope，完整自查仍0。

## 61. 景点推荐分的显式身份绑定与 Top30 验证

- 本轮仅北京、济南景点，按当前已解析提及重算：唯一mention ID数×2 + recommend占比×5 + 不同note ID数×0.5。合并不能相加旧分或取旧最大值；同篇重复抽取的不同mention ID沿用现行公式，不冒充多个独立笔记。高分未知来源仍可能改变名次，不能跳过后称真实前30已完成。
- 上游通过实体override `recommendationPolicy=resolved_attraction_mentions_v1` 显式启用；consolidate_places必须收到当前实体提及映射，否则拒绝导出。只接受attraction/park/museum/scenic_area，其他类型不受这次策略变更影响。
- 导出 `payload.recommendationIdentity={version:1, policy, entityId, revision, inputHash, mentionCount, recommendScore}`。inputHash为按ID去重并排序的 `(mentionId,noteId,mentionType)` JSON的SHA256；不把内部override直接作为用户事实。空有效提及可为0分。
- 下游 `validateRecommendationIdentity(place,previous?)` 验证v2实体ID/版本、64位哈希、景点类型、非负安全整数提及数、有限非负分数及payload一致性；已有绑定不能撤掉，相同输入哈希不能换分或计数。原有身份版本防回退与来源快照门禁继续适用；哈希是输入指纹，不是下游重新读取上游原文或密码学签名。
- `prepareImportedPlaces`首次写入前校验，`reconcileImportedPlaces`同事务权威替换recommendScore/mentionCount，覆盖xhs和goldset旧高分。该标记不等于mentionSources，不扩大为全文、时长、主题或媒体scope，不清除其它既有资料。无标记旧数据保留既有合并规则。
- 原先导出预期通过但实库8行仍旧高分，故同步成功必须再比较实际存储中的绑定、分数和计数。batch-73/sync-03的两城真实导入预演检查19个已启用实体，重复导入稳定，4次导入审计逆序回滚保持旧库；来源版本相同的元数据刷新保持原关系，版本变化才要求旧关系暂不可消费。
- `placeRecommendationIdentity.test.ts`覆盖非法绑定、旧绑定撤回、同输入冲突，以及xhs/goldset真实旧高→新低、重复导入、旧文件拒绝和资料/图片保全。研究脚本支持新的sync尝试目录，失败工件不覆盖。check-batch-state必须核实分数实际落库，不能仅凭进程退出0或导出JSON成功。
- Top30消费验收由 `IDENTITY_FLOW_TARGETS` 显式冻结目标排名并逐行纳入run-flow；默认只挑revision>1不能覆盖全部Top30。目录解析、SQL、真实向量参与的混合召回、隔离候选/排程身份/保存/编辑/重访分别留证；它们不证明来源语义已确认，也不证明缺坐标地点的真实导航可用。
- 原始表仍保留旧实体，数量不代表归一失败；核验ACTIVE根、redirect_to及现行memberIds。第72—74批20个主实体/21条记录实际变更不等于20个或60个景点语义全部完成。尚有泛称与组成边界时保持in_progress，等待补证或用户明确调整标准，未验收不提交归档。
- 首尾保全必须逐字段比对消费内容。全城重导出会令此前已安装的日期修复在尚未同步的城市生效；本轮北京962条记录/1345个看点observedAt从旧compiledAt改为原笔记日期，逐项按sourceUrl与原observed_at确认，非目标文字/引文保持。该元数据变化需单列，不称非景点整行零写入，也不能以笼统忽略observedAt代替来源核验。

## 62. 单次误写不能升级为全局别名，合并后须验证补位实体

- 第21批景山案例：笔记504的图片只支持把提及3148的“石景山公园”纠正为景山。使用实体merge使通用apply_decision继承旧主名，造成全局别名；证据说明里写“仅本条误写”不能限制实际身份合同。修复前新同名提及与下游纯名称查询均可复现误归景山。第78批修复见第63节，历史复现报告仍保留。
- 审核前要区分同义实体合并与逐提及纠错。只有前者才能继承全部成员名；后者须先处理来源范围及具体提及，再按现有excludeNames门禁移除错误名称，不绕过范围校验、不直接改库、不回滚覆盖后续版本。范围治理影响网页资料和媒体时，必须验证资料保全，不能把图片延后范围当作静默清空或假确认的理由。
- 目录测试从现有aliases生成正例，只证明配置可消费。语义负例必须来自原文或用户明确纠正，独立于待测别名配置；把错误复现成功写为defectReproduced/fixed=false，不能作为身份治理通过。
- 用户可明确指定行程粒度。第75批天安门并入天安门广场保留两名和旧ID，不能由此推导城楼、升旗、安检口等也应同义。核对主源坐标、旧来源保全、关系端点与自环，城楼周一闭馆不得进入广场排程事实；用户指定合并不等于所有内容事实已审完。
- 每次合并后重新排名并检查补位者的实际推荐分。国子监补入北京第30名时，旧库31.55仍包含未解析组合名提及，当前9提及/8笔记重算26.44；第76批按显式评分策略同步修正。保留失败报告，不能仅因此前60行全通过就跳过新入选实体。

## 63. 已合并错名来源的有限名称纠错

### 范围与入口

已由原图确认的一次误写，被历史合并扩大为全局别名时，可以沿`apply_scope_decision`提交`mode: name_correction`，再沿`apply_decision`的`excludeNames`移除错误全局名称。只适用于已合并到另一个主源、所有相关提及仍归同一现行根的错名来源；不是跨主体拆分或全量事实审核。

### 持久化与消费合同

- `place_identity_scope.mode VARCHAR(32) NULL`由`migrate_place_identity.py [--apply]`幂等迁移；NULL是原全量事实scope。普通旧审计不增加字段，回滚恢复原模式。
- 新请求使用`mode: name_correction`；每条assignment只含`mentionId/inputHash/entityId`，必须覆盖命中名称的全部当前提及。证据含`kind: mention_name_correction`、审核文件和结论；来源/提及指纹、实体版本及城市锁沿用原门禁。
- 已审误写解析为`reviewed_assignment`；新增同名提及为`unreviewed_mention`，原文变更为`changed_input`，不退回全局名称。错误名称的`excludeNames`前置校验保持。
- `managed_entity_ids()`表示全量事实及图片治理目标，不包含仅纠错scope；`load_image_catalog`也不能因为同篇有纠错提及而把整篇相册变为受控。既有全量scope与逐图分配仍优先约束同一目标。
- 名称纠错不新增导出的`mentionSources/imageIdentity`，不续绑网页简介，不改原始提及或图片审核。推荐分仍使用实际解析提及；关系端点仍按原文位置及本条scope验证。历史旧ID保留，错误名称加旧ID也不得解析成功。

### 校验及错误矩阵

| 输入或状态 | 结果 |
| --- | --- |
| 已合并错名源、全部已解析到同根、完整指纹及逐提及证据 | 可预演及审计应用 |
| 原主源、主名、跨目标、null、遗漏或陈旧提及 | 拒绝 |
| 新实体、扩展guardedNames、事实排除、补警示或网页保全字段 | 拒绝，不扩展到事实或媒体治理 |
| 已有完整scope改为name_correction | 拒绝降级 |
| 纠错scope后续请求省略模式 | 拒绝隐式升级；完整事实治理须显式`mode: facts`再预演 |
| 持久化未知模式 | 拒绝读取，不回落为普通未受控消费 |

### 示例与验证

景山第78批只把3148的“石景山公园”限定到景山，旧源1508/旧ID继续保全，主源1063不改。原37提及/95.36分、网页简介和原媒体应保持；不把预约事实或照片语义标为已审。普通旧scope维持原合同；把完整分店拆分伪装成名称纠错属于反例。

`test_name_correction_scope_db.py`覆盖真实SQL、原文与网页保全、两种媒体控制入口、新误写/原文变化、完整scope升级与禁止降级、幂等及逆序回滚；实际export断言除身份字段外所有payload不变。`sync-contract.test.mjs`要求`scopeMode/correctionMentionIds/excludedNames`显式冻结且无媒体合同，完整scope不能借该模式省略提及清单。业务批次另需冻结全城预演、导入/重复导入/回滚、实际facts及专用lookup前后比对和独立错名负例。

错误：仅删aliases，或为了修一个错名让原图片静默退出。正确：逐条绑定已审误写，保留全局排除门禁，限制消费变更范围，并分别验证资料字段和实际返回。

## 64. 扩城配额与既有类别治理

1. **范围**：Top30任务扩城时，沿父任务已授权城市清单显式选择，不从数据库城市全集推断；兼容回归包含其他城市不构成主动治理授权。2026-10-09新增上海、厦门、广州、成都、杭州、西安、重庆，云南仍排除。
2. **入口**：任务`freeze.py --cities <城市...>`只读冻结；`rank.py <snapshot> --classifications <review.json> --out <new.json>`从快照生成cityScope；`IDENTITY_FLOW_TARGETS=<ranking.json> node run-flow.mjs <新编号>`要求城市清单与声明一致，每城恰好30个不同ID。少于30的真实语料仍须如实交付，不能凑数以通过此完整30项验证入口。
3. **合同**：已治理`overrides.category=美食/购物/住宿`优先于旧源`place_type=attraction`，不能让早期仅修粗类的记录重新占景点配额。新增任务类型审核仅限定配额，保持业务行；须绑定entityId、名称、revision、完整mentionId/inputHash集合和原文引述。
4. **门禁**：类型审核发现新提及、原文变化、实体版本变化、重复审核或引述不在原文时拒绝沿用。未决身份、来源范围和类型不能因为目录或flow全绿就标记为已审核。完整scope城市不得复用仅重建实体/提及的无scope预演。
5. **案例**：第79批以东方明珠全名根的原主源位置承接简称，保留旧ID并重算35提及/89.43分；武康路全称归一保留武康大楼独立。夜游活动、轮渡码头及商圈按已核对原文退出景点配额，不将其身份治理扩入任务。
6. **验证**：`test_rank.py`覆盖粗类优先、新/变更提及、陈旧版本及引述不匹配；整城冻结原文/摘要/分配/旧行/媒体保全、隔离导出幂等及回滚、双同步与真实SQL/向量分别留证。flow的schedule验证身份进入排程；缺坐标景点也可能通过，不能据此宣称位置或路线可行性已验证。
7. **错误与正确**：错误是看旧attraction把已治理餐厅补进Top30、按同名把陵墓和整体博物馆自动合并、把210项目录通过称为210项原文审核完成。正确是尊重现行类别和已确认组成边界，逐条记录当前证据、实际变更及未决项。

## 65. 有既有范围城市的同义归一预演与扩城评分

- 同城存在scope时，简单同义合并仍只允许目标不在任何既有scope的entity_ids或withdrawal_entity_ids中；受控目标须使用专用范围决策。`freeze.py --full-governance`附加完整原笔记、采集/提纯日志、联合范围来源、提及分配、原图片与逐图分配，禁止仅种入实体和提及而丢掉其它治理。
- 一次性库须处理RawNote与ExtractLog的循环外键、SQL NULL与JSON null的区别及timestamp时区显示差异；仅按字段类型规范化同一时间点，不能忽略正文或资料差异。临时延后外键、按已冻结图片分析顺序重排堆表只发生在一次性库，实库应用仅调用版本化身份API。
- 旧导出图片分析查询未固定排序。普通INSERT可能把短行放回前页空槽，写入顺序不等于扫描顺序；第83批隔离重庆曾使非目标“大剧院江滩公园”第二条提示变化。完整重建必须严格匹配治理表、该次消费顺序及正式导出的每个地点；不能忽略tips差异来过关。通过后仍要检查其他导出、主源位置、精确提及并集、幂等、逆序回滚及回滚导出。长期排序协议调整另行治理，不在身份合并中静默改全城事实选择。
- 已核实案例：沙面/沙面岛、黄厝沙滩/海滩、龙门浩/龙门浩老街、西安鼓楼/鼓楼；沙面公园/堂/大街、黄厝片区及溪头下、下浩里、钟楼和商户机位各保留边界。note1261同篇路线与正文交替使用两种黄厝沙滩名，note19/249同篇交替使用龙门浩全简称，note2646同篇交替使用鼓楼全简称；这些明确同义证据不扩大成图片或全量事实验收。
- `govern-scores.py --plan`要求授权城市声明、快照/排名双哈希、目标数量及显式暂缓原因。对每城完整实体与提及指纹、旧scope/分配/来源/摘要核对后，才为已解析景点提及启用既有推荐策略；全城原始摘要保护不能硬编码北京济南。第81批74项修复不表示来源语义全部审完。
- 合并后重新审核补位者。龙门浩合并后鹅岭栈桥补入，其旧分14、当前8提及/6笔记应24；原文明确徒步主体，可修分，原无坐标仍保留。麓湖CPI类型未证实，公开检索超时不能成为类型结论，保持暂缓。调用链验证与实际召回覆盖分别列出，不以目录210通过代替真实向量覆盖。
- 失败尝试采用新目录或新版本计划保留；SQL异常仅输出错误类型和代码位置，避免驱动打印包含笔记链接的完整参数。`test_city_merge_plan.py`覆盖缺失完整治理表、缺正式基线、受控目标误用简单合并、越界提及和伪造原文引述；实际范围与回滚以隔离数据库证据为准。

## 66. 来源错配、地域配额与精确限定别名

- 完整scope的审计快照还包括`canonical_place_source`和原`place_relation`。整城导出匹配不证明这些表已重建；须补齐并核对前后保持及逆序回滚。第86批实库前置曾拦下两表夹具遗漏，事务回滚后补齐，不能通过忽略字段使其通过。新建待审行的自增ID可在跨库比较时单独排除，fingerprint/status/detail及全部旧行仍须精确比较。
- 先合并同体再建联合scope时，scope.expectedRevisions使用合并后的主根版本，只声明当前主根；导出预期包括最终完整mentionIds。旧简称ID仍由主根兼容，不能把已合并旧根要求成新的撤回导出行。第86批钟楼24确认、3待审，机位免费登高reason按subject_mismatch排除；原所见塔体看点、负面体验、原文和旧ID保持。仅地点身份可辨不表示拍摄机位与塔体事实相同。
- 地域与类型配额审核不修改业务表。`rank.py --geography-reviews`只允许已撤回且无有效归属的异城记录，绑定版本、来源集合、完整未决提及、scope与全部笔记地域引述。第29批已隔离的成都note759北京记录不重新分配，不将历史PENDING改为已解决；只消除其占用成都配额的错误上界。
- 公开类型证据须核对实际fetch正文、URL和文件哈希。第86—88批期间麓湖CPI由开发商项目案例正文的商业更新与商业集群说明退出景点配额；搜索生成答案中的CBD/武侯区/其他开发商未经原页支持，不能采用。原始笔记把地点列进“景点”清单不能单独推翻有来源的商业属性，业务类别仍保持只读。
- 新增精确别名可纳入原未注册提及，但必须显式`admitMentions`，核对无现有归属、无scope、未注册状态、输入哈希和包含完整原名的原文引述。日光岩（鼓浪屿）是地域限定的同体名称；南大门、主街、崇文门段或“祖父的阳台”等具有子项/范围含义，不能照此去括号后并入母项。新别名进入导出、SQL与向量后重算提及分数并检查旧ID。
- 新入榜/变更者重新实际召回；复用原结果须与前一已通过快照逐项比较实际消费输入，并说明复用数量。第88批后4项新测、206项完整下游行相等（仅忽略compiledAt）后复用；不声称本轮重复请求全部210项。排名、目录、实际召回和身份行程消费分别留证，技术通过不等于语义全部完成或用户验收。
- `rank.py --mention-boundaries`可将已核实不等同母项的未分配提及移出该母项的潜在加分集合，但必须在`reviewedNonEquivalentMentions`保留逐条证据；原业务PENDING不改。必须绑定母项版本、mention指纹、完整解析状态/范围、原文引述及明确not_same_entity结论；已归属提及、无关提及或过期证据拒绝使用。它不创建新的具体实体，也不等于正式part_of关系。榜单消费字段与快照保持不变时可用逐字段投影证据继承原技术验证，不必因风险标签变化重复全套。

## 67. 既有scope序列、景观与交通提及及综合体范围

- 一次性库以显式ID重建旧scope、分配和review后，必须将对应序列推进到已种入最大值之后；否则新增scope可能与旧主键碰撞。序列修复仅用于临时库，不得借此修改实库治理表。第89批重建重庆旧2个scope及1197条溯源，预演/逆序回滚和实库审计比较通过后才应用。
- 同篇路线与正文交替使用李子坝、李子坝轻轨穿楼、李子坝轻轨站可支持本次景观身份归一；纯换乘提及575不能自动成为景观推荐。825原图文有地点行程而预约页未列该地点时，可保留身份并审核排除错配的预约、reason与evidence_text；原warning类型不改写，不能把泛化预约宣传当成具体景点规定。事实投影将NULL fact_value规范成空字典不等于原数据变化，保全检查需同时验证原始行及投影中应保持的字段。
- 类型审核要区分整体与组件。广州塔广场有明确商业广场正文，可退出任务配额；来福士官网区分建筑综合体、底部购物中心和独立观景设施，不能因附设购物中心自动排除所有建筑外观提及，也不能把高空设施并入整个建筑群。保留尚未完成的逐提及边界，不将搜索生成答案的开闭门推测写进事实。
- 合并后补位者仍需原文审核及实际召回。第89批塔坪与北仓在路线中分别列出；李子坝/塔坪2项新测，208项完整存储行相等后复用。`verify-retrieval-reuse.py`显式传入前后快照、旧报告及新目标，旧默认路径继续兼容；快照哈希、目标集合和逐项输入相等均须校验。

## 68. 活动、交通及路线终点的来源边界

- 母景区的名称出现在酒店接驳广告、限时活动、纯换乘或指定机位中，不代表该条推荐整个景区。先沿正式scope隔离，再用任务mention-boundaries的`activity / transport / hotel / photo_spot / area`绑定原文、母项版本及完整解析状态，消除母项潜在加分。不能对仍已归属的提及只改排名；未知类型、陈旧版本或已归属状态必须拒绝。第90—92批及李子坝575的原PENDING保持，不由此创建域外新主体。
- 路线中明确列出广场作为终点，可以保留地点身份，同时以`factExclusions.reason/evidence_text`排除整段路线的设施、铺装等错配事实。第94批天泉步道广场5525/6097保留身份，6876明确为上方步道机位则null待审；不能将“全程3公里”“沿途洗手间多”当广场自身资料，也不能据此合并广场和步道。原数据、旧位置及其它提及事实独立核验。
- scope-only批次可能有空的实体decisions数组。人工名单必须同时读取scope-decisions并标明来源隔离，不能因空数组把迪士尼乐园写为本轮完全未复核；这也不代表其所有语义已完成。共用预演器须按当前城市命名工件，旧错误文件名尝试保留，新目录重跑并以正确版本应用。
- 每次补位须比较实际存储分。田子坊3提及/3笔记应12.5但旧库仍10，复用门禁阻止进入通过报告；第93批修正后才进行4项新召回及206项完整行复用。身份flow可在分数尚未同步时通过，不能用它替代评分一致性检查；最终验证绑定同一快照、目标集合及当前版本。

## 69. 来源隔离的类别保全与服务语境

- 完整scope停止消费旧摘要themes，导出分类可能从主题推导值回落到源类型默认值。第96批大唐不夜城从娱乐回落文化，预演的类别保全检查拦截，不能简单删除断言放行。仅隔离来源且需保持旧产品类别时，可在scope后同事务调用版本化实体API显式保存旧category；预期须包含最终实体版本和全部提及，两个审计按实体修订→scope逆序回滚，并核对整城恢复。
- 第96-v2批明确保持娱乐，scope版本修订至2，随后实体版本至3。旧混合themes不恢复；这表示保留既有分类，不表示新分类语义审核已经完成。共用scope预演器的可选实体决定必须纳入计划指纹、实库/预演审计比较、decisions工件及逆序回滚；原空决定批次保持原计划指纹兼容。
- 摄影/妆造服务评价不等于景区，也不等于可定位的独立机位。原文仅在标签出现大唐不夜城/大唐芙蓉园，或主语是“238元妆造、不含拍摄”，先正式scope隔离，再可用任务边界`subjectType=service`排除母项潜在加分，不创建商户。assigned/stale/unknown门禁继续适用，原文及PENDING保持。名单须将纯类别保留与来源隔离准确标注，不能误报为评分治理。
- 来源隔离可改变关系证据强度。96-v2导入后大唐不夜城—大唐芙蓉园弱关系退出，大雁塔—大唐不夜城由强降弱；必须单列预演与实库变化，不以旧关系条数不变作为通过条件，也不将旧强关系无来源地保留。身份流程、推荐分及真实召回继续绑定同一最终快照。

## 70. 查询行序、跨百批次及原文主语覆盖

- scope与提及分配表的查询顺序不属于业务身份内容。完整预演按`place_id / mention_id`核对唯一键、完整键集合及每行全部字段；不能因列表顺序不同认定业务变化，也不能忽略实际字段差异。99批前三次预演确认仅行序不同，原失败目录保留；后续实库审计、整城导出和逆序回滚仍完整执行。
- `factExclusions`原文摘录须同时覆盖所排除的描述和当前提及主体。田子坊11245描述整份三日游规划，短摘录没有主体，被既有门禁拒绝；99-v2扩大为从规划说明到田子坊路线行的连续原文后通过。不只修改rank、不清掉可确认的路线身份，原3条提及及分数保持。
- `sync-contract.mjs:validateBatchName`供地点/关系同步、导入预演与实库前后核对共用，兼容两位历史编号及三位以上编号、可选`-vN`后缀；数字位数不能成为第100批无法同步的障碍，路径穿越、尾随字符和缺失编号继续拒绝。`sync-contract.test.mjs`覆盖历史标签、100/101-v3及非法路径；TypeScript调用者有对应声明。
- 景区内拍照不自动等于摄影服务。12041/12317将妆造商户和兴庆宫实地路线分别列出，保留公园身份；12266明确只评爱心树，隔离后同篇11883独立树的负评与身份保持。不得为了清掉错配的负面事实而抹除作者立场，也不能重复把同篇旧树提及创建成新实体。

## 71. 窗景、地标观景与独立场所的来源边界

- 酒店或餐厅正文中“窗边看到某地标”属于经营场所体验，不能自动给地标加分；同篇另有明确餐后游览清单时，按实际列出的地点分别判断。101批保留外滩11201/11313餐后散步，而102-v2隔离同篇仅餐厅窗景的东方明珠11311；11202另有餐后地标打卡且未指定独立站位，保留观景身份，不据此声称登塔或跨江。
- 内部设施与外部独立场所不可按关键词一刀切。东方明珠观光廊属于正文明确的塔体体验，保留；正大广场晚餐、环形天桥、陆家嘴三件套各自保持身份。能够绑定原文时按字段排除错配描述，不清掉已明确的路线身份，不把“机位”或“餐厅”一词本身当作全部隔离依据。
- 原提及被抽成全名、原文仅有简称时，既有事实摘录门禁不一定能绑定；10132即因此保留原字段待核。不得伪造全名原文、偷改原提及、放宽通用门禁或把整条有效路线隔离来绕过检查。新计划须使用新版本并保留失败工件。
- 来源范围改变后的地点及关系均需重算并同步。101/102-v2上海关系61→59→58、强关系22→18→17，属实际证据变化；全量目录、变更者真实召回、未变者完整行比较及210项目标消费分别留证，不能宣称所有原文或坐标因此均通过。
- 豫园103批按实际原文区分园林、老街、商业区及灯会：同篇分别列老街→园林→城隍庙，不得据同一地理片区合并。明确餐后游览与酒店/餐厅邻近参照分别处理。混合描述按字段排除，10369仅清除含九曲桥的evidence_text并保留园林reason，10957仅清除含灯会的reason并保留园林引文；原警示及立场保持。
- 公开补证绑定实际fetch及文件哈希。政府新闻办页面支持园林与商城灯会的区别；百科原段明确九曲桥等未划入园内，仅作与社区分区正文一致的辅助证据。所引黄浦区原页两次提取为空，不能冒充已读取；搜索生成文本与抓取正文冲突时不采用生成结论。旧九曲桥主源定位在青浦，不能将豫园桥体描述直接转给该根或借机补坐标。

## 72. 同篇路线与住宿描述、地点摄影及阅读覆盖

- 提及的抽取描述来自住宿段，不代表同篇没有该景点的独立路线身份。105批人民广场10259/11255的完整正文都在Day1明确列出广场，保留归属，只排除住宿reason/evidence_text；9981/10017/10049仅住宿参照、10148仅美食分区则隔离。先读完整正文，不按短reason直接隔离。
- 建筑本体、馆内大厅、桥上和道路景观拍摄不因photo_spot类型或“机位”一词自动退出景点。应判断是否实际指向另一经营场所、独立站位或异主体；桥旁咖啡与桥梁本体、道路旁未具名洋房与整条街分别处理，未定具体身份不新建地点。馆内拍到塔不将该提及转给塔；保留地点体验也不证明室内开放或所有展陈事实已核。
- 全文仅含多个地域及摄影标签时，能够支持“身份证据不足”的待审状态，不当然支持not_same_entity。正式scope隔离与任务排名上界排除分别需要证据；不得为了消除算法风险，把未知机位伪装成已确认的独立主体。
- 完整提及阅读、待应用治理、未决边界和用户验收分别记录。35项/370条阅读记录覆盖上海当前30候选，不等于30项身份全部闭合；馆区、河岸范围、错写全名的引文门禁与已识别来源错配继续列出。沿用阅读证据须核对主体、当前提及及完整原笔记全部字段。

## 73. 仅身份治理的下游独有媒体保全与失败恢复

- 上游导出无`images/imageUrl`不证明下游没有旧封面。第107批鼓浪屿上游无图，下游`coverImage`及1项`imageGallery`独立存在；新增完整scope的空`imageIdentity.approved`会令正式导入过滤旧图片，并改变实际facts消费。图片暂缓不能解释为允许清空，更不能伪造已审核图片通过门禁。
- 图片暂缓批次的隔离双导入必须验证所有旧行已有`coverImage/imageGallery/amapPhoto`字段及已有facts图片返回；不能因为新行有`imageIdentity`或重定向就跳过。预演报告显式声明`all_existing_fields_and_facts`及实际消费保持，正式前置检查绑定城市、地点/关系/旧库哈希。历史仅检查非受控行的报告不得声称全城图片保持或用于新导入前置。
- 发现误写后先停止该批。使用`rollbackIdentityImport`按关系→地点逆序恢复，先在事务内执行同一API预演并ROLLBACK，再以当前状态及审计ID绑定正式应用；上游再按实体评分修订→scope调用`rollback_decision`。完整七城快照核对原资料、旧媒体、旧分配和行程，新增已回滚审计保留，不伪造未执行过，也不直接改业务表。
- `batch-107-rolled-back.json`阻止旧批同步及计入当前人工名单/保全成果；复用旧applied文件不表示该批仍有效。后续正式导出来源版本可单调增加，不能为恢复强制降版。第107批两端恢复后，七城4036来源/8798提及/1051笔记/3737旧行及201行程保持；鼓浪屿恢复53条、134.4分与旧1图，50篇阅读保留为待应用证据。
- 共用完整scope入口在应用前检查冻结下游旧媒体；有旧图而尚无合法保全方案的对象暂缓来源范围切换，继续其他对象。既有名称纠错模式不能用来伪装完整来源隔离。鼓浪屿及集美大社旧媒体仍须专门解决保全，不因此扩展图片语义审核范围。
- 第108批中山路预演另暴露全称/简称引文门禁：5363抽取全名`中山路步行街`，正文只有`中山路`。保留其正确的有限Citywalk身份与原描述待核，不放宽事实排除门禁，也不改为null来消除描述。108-v2只应用可通过原文门禁的5条字段排除；6808纯标签仍保留未知潜在分，不能冒充已证实非同体。

## 74. 旧运营资料保全与同体合并的完成边界

- 图片文件为空不代表完整scope可无损切换。南普陀112、厦大114的旧营业和免费字段来自原图片文字分析；`scoped_facts`仅从当前范围内的提及重建，未保留这些价格输出。原分析仍在库内不等于消费保持；此次身份来源隔离没有提供删除旧资料的依据，也不将旧冲突说法升级为现行事实。
- 共用研究预演器的`PRESERVED_TARGET_PAYLOAD_FIELDS`将要求保持的目标字段纳入计划指纹；先完整导出并逆序回滚，再核对逐字段结果，差异只记录实体ID和字段名。114的营业、票价、预约备注和证据不一致使预演整体失败，`--apply`已实测拒绝。旧未启用此检查的成功报告不代表运营资料保全通过；112继续暂缓，后续方案须新版本预演。
- 无既有scope目标可单独通过版本化实体API完成已证实的同体合并。113植物园、115环岛路完整冻结原治理、溯源及原关系后，核对主根旧运营、提示、内容、媒体和其余地点导出全等；下游另做严格媒体与实际消费核验。仅合并不代表所有来源已清，植物园6248花展仍待隔离，不得将这种合并包装成绕过scope的完整来源治理。
- 阅读台账在合并后按原主体与旧根提及并集更新，逐条核对原字段、指纹及完整笔记，不将合并前主体全等作为错误前提，也不把旧根边界阅读自动计成额外已完成主体。环岛路旧点位于不同路段，主根位置保全不表示长道路的行程定位已核准；租车避坑意见和电动车许可冲突继续按原作者保留。

## 75. 旧运营输入绑定与跨层保全声明

- 完整scope可显式`preserveOperationalFacts`保全同根原主源的旧价格、营业、预约及原证据；请求只列当前完整匹配来源及输入指纹、旧投影哈希和`subject_only_preservation`证据，不接受新运营值。来源绑定完整图片文字分析、笔记正文/标题、日期、URL和可用状态，保留旧选择顺序；普通导出与保全必须共用投影，scope后按有效提及及事实排除重算。不能恢复已排错配事实，也不能让既有未保全受控根重新消费旧池。
- `place_identity_scope.operational_facts`为可空JSONB，版本化scope写入及审计；绑定实体revision、提及hash，消费与回滚均校验原输入。后续scope修订必须显式续绑或给空列表移除，原文/来源过期拒绝，不能静默采用新值。该协议不代表媒体已审核或现行运营已核实。
- 下游`operationalIdentity`仅允许`legacy_operational_preservation_v1/sourceReview=subject_only/currentFactsReviewed=false`，导入前校验同实体版本及六字段摘要；将此键纳入权威替换清理集合，防后续导出省略时残留旧绑定。关系来源`supplementalSources`允许同scope的旧无kind警示与新运营kind各一条；按scope及kind去重，未知kind拒绝，均参与来源摘要而不生成关系端点。
- 实际双导入预演核对保全字段与导出及旧库一致、保全声明落库、旧营业facts消费一致，并继续严格检查全城旧媒体及消费、重复导入和逆序回滚。临时上游库未继承关系导出版本计数时，不能放宽下游版本门禁；仅可在专用预演副本中明确记录现行来源到下一版的计数模拟，正式应用后必须重新导出真实版本、重新预演及前后检查。112-v2按此保留旧南普陀运营资料，同时酒店窗景退出。
- 判断“仅住宿/仅活动/仅站点”前，除完整正文外还应核对已有图片文字分析。曾厝垵5546正文只写住宿负评，但note1298图片索引1有明确逛吃与行程安排，不能按仅住宿误隔离；该补证不意味着重新看图或图片语义已审。绑定完整rawNote及文字索引哈希，保留原负评；行程17:00–19:00也不能借保全声明升级为本轮确认的营业时间。无补充文字的对照也应留证。
- 冻结`row_to_json`的日期文本与生产`datetime.isoformat()`可能仅有小数位补零差异，却产生不同输入指纹。119的9个引用中仅note1298/image1的`observedAt`发生此差异，来源集合、顺序及时间值全等。诊断只输出引用、hash相等标志及差异字段名；新研究请求按生产读取器格式构造日期，以119-v2重新完整预演及实库验证。不修改原日期、放宽指纹门禁或覆盖失败决定；生产协议9文件保持原哈希。

## 76. 无图片文字输入城市不能声明旧运营保全

- 旧运营保全的来源绑定是图片文字分析：`operational_preservation.py` 用 `relevant_images(ordered_notes, fact_names(source.name, city))` 重建当前匹配来源，`not expected_refs` 或与声明不等即拒绝（`完整保持当前匹配来源及顺序`）。城市 `governanceState.imageNoteOrder` 为空时该集合恒为空，空列表被显式拒绝，不能伪造、不能漏选、也不能用笔记正文代替图片索引。
- 下游导出只在收到保全声明时才写 `payload.operationalIdentity`；`verify-relation-city.test.mts` 按该键计数 `preservedOperations`。因此无图片文字输入城市的 scope-only 批次无法满足 `record-preserved-scope-validation.py` 的 `preservedOperations>=1` 门禁，不能靠放宽记录脚本或导出逻辑消除。
- 第121批实证：广州永庆坊（无旧媒体）完整scope预演15项全绿并应用（48条/124.69分/rev2），随后因无法声明保全而整批逆序回滚；实体、成员、提及分配与完整治理状态逐项等于冻结快照，`batch-121-rolled-back.json`阻止重新同步。广州塔本体另有旧封面与1项图库，与其并列为两类不同的未决项（缺运营输入／缺媒体保全方案）。
- 该结论只限制“完整来源范围切换”这一类决定；原文阅读、类型配额、排名边界与名单交付继续照常，未决项必须在名单和台账中单列，不得声称已隔离或已排除潜在分。后续若要支持无图片城市，须新增与图片无关的旧投影输入协议并让导出、下游消费与回滚共用同一投影，不能以本节的暂缓为由改门禁。

