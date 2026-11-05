# 独立图库逐图身份：实现、迁移与首批实图

状态：实现与本阶段验证完成；不是全任务验收。本文记录独立图库首批时的batch25状态；随后国博/景山的batch26已应用同步，见`catalog-alias-source-review-20261007.md`。下游独立图库首批8张已应用，禁止当作未执行请求重建。

## 实现

- `independentPhotoSources.ts`只读提取人工和模型目录，稳定图片键、来源指纹、字节/官方URL摘要均单独冻结。治理默认核验本地字节；在线读取仅生成指纹，最终采用仍逐图核验字节和媒体。
- `independentPhotoIdentity.ts`在地点导入共用的城市事务锁下，验证当前来源城市、新旧实体版本、图片版本及重复资产归属；空目标显式撤销。应用和回滚均二次读取来源，变化则整事务失败。审计key不可复用。
- `boundPhotoLookup.ts`按现行实体ID/版本挑出具体图片。人工图保序、至少一张即不混模型图；模型补图继续受原人工排除约束。已分配或撤销的图和同城副本不能走旧名称回退。无匹配绑定立即返回，避免逐实体反复扫描整份反馈。
- `photoEnrichment.ts`接入正式生成图片入口；受控实体无有效分配不回退、不进入裸名补图队列。多层尾括注仅用于阻止回退，不能据此确认身份。
- `independent_photo_assignments / independent_photo_changes`由schema和迁移同步定义。`INDEPENDENT_PHOTO_STATEMENTS`允许受控运维只迁移这两张表；正常启动使用同一SQL。
- 地点导入审计新增可选`independentPhotos`快照，后续图片分配阻止过期地点回滚；旧审计缺字段仍保持原边界，不删后来绑定。
- `apps/server/scripts/govern-independent-photos.mts`支持snapshot、decisions、rollback，默认事务预演，显式`--apply`提交；输出文件不覆盖，异常退出关闭输出句柄和数据库连接。

## 验证及发现

1. 首轮新功能及选图/审核24项通过，但尚未真正断言异步补图次数。后续改为记录次数后，复现多层括注绕过入队限制，失败日志`downstream-place_identity_test_1791345981680.log`保留；修复单项日志`...1791346022953.log`通过。不能以被catch吞掉的`assert.fail`作为异步禁止行为的验证。
2. 36项关联回归通过：`downstream-place_identity_test_1791346134383.log`。
3. 扩大到真实地点/图片/关系/撤回导入、人工图库、审核、队列、采集、旧行程补图等76项，全通过：`downstream-place_identity_test_1791346391384.log`。
4. 最终22项独立图库测试通过：`downstream-place_identity_test_1791347136467.log`。覆盖错城来源、哈希与版本拒绝、两分店拆图、人工反馈、撤销/缺文件/同图副本、实体导入并发、来源并发、真实CLI与行程保存/编辑/旧版本不变。
5. 根目录`npm run typecheck`通过；扩展`tsconfig.verify-joint.json`检查产品治理CLI和研究脚本。新真实批次探针的Unsplash回调最初误把asset写作string，专项检查发现并修正，最终通过。
6. 真实八图探针首次通过耗时254秒，暴露无绑定实体仍扫描整份反馈的多余工作。增加无匹配即返回后，应用后同探针18.7秒通过。不是降低身份或图片验证门槛。

## 实库迁移与不变性

`independent-photo-migration-preview-01.json`、`independent-photo-migration-applied-01.json`、`independent-photo-postapply-check-01.json`均保留。

只执行两表及索引SQL，重复执行结果一致。迁移前、迁移后和首批应用后，以下行数和全行摘要均相同：

| 下游表 | 行数 |
| --- | ---: |
| canonical_places | 5495 |
| research_evidence | 7802 |
| place_relation | 270 |
| data_import | 24 |
| place_identity_imports | 41 |
| trips | 201 |

未导出用户行程内容，只在数据库中计算摘要。迁移后图片分配0/审计0；首批后8/1。上游scope4/source4/mention assignment7/image assignment0不变，没有执行任何旧上游批次。

## 12城图源冻结

`independent-photo-source-audit-1791346022461.json`是较早的元数据扫描，不核验字节。
`independent-photo-freeze-01.json`随后实际读取本地媒体并校验字节，外链只核官方URL摘要，不声称验证远端文件；总1944条来源、633条通过媒体与既有审核资格，均不是本轮已确认身份的图片数。

上海后台从36目录429图增至37目录442图，故不能强求两次快照数量相等。最新冻结warnings为空，无图片键冲突；符合既有资格的图片没有跨城相同资产。重庆459及厦门/成都四个撤回实体均无匹配独立图源，未为演示补图。

冻结发现人工目录与正式身份表三组映射不一致：

| 目录/别名 | 正式解析情况 | 处理 |
| --- | --- | --- |
| 国家博物馆 / 国博 | 两个v2实体 | 待核实，未自动绑定或合并 |
| 景山公园 / 景山 | v2公园与旧实体 | 待核实金集及来源边界 |
| 王府井 / 王府井大街 | 两个v2实体 | 片区与街道可能不同，不能按图库别名强并 |

这些是新发现的下游跨目录核验项，不能混入上游138对已冻结计数，也不能称全城已验收。

## 独立图库首批（已应用）

目录：`independent-photo-batch-01/`；key：`independent-photo-batch-01-beijing-20261007`。

- 北海公园：`4c43da4bfc3095a1bd5b60ed08a0b15d` revision2，原人工6张；逐图核对琼华岛白塔、永安桥、牌楼、长廊及湖面，与原来源互证。
- 八达岭长城：`4d453b43bd9156f2b638278e661c924f` revision1，原人工2张；沿用已核实Commons作品115371400/32396898的说明和分类并复看实际画面。不是只凭泛长城外观判断段落。
- 联系表`contact.jpg`及映射`contact.json`；决策`decisions.json`逐图记录原证据、本轮观察、来源库摘要及图键。保留原人工选择、顺序、署名，不新增下载或裁切。
- 实库事务`preview.json`通过后，`applied.json`正式提交成功。无实体版本变化，无新上游imageIdentity binding。
- 应用前真实来源探针：`downstream-place_identity_test_1791346828913.log`。应用后：`downstream-place_identity_test_1791347203954.log`；对应`verify-*.json`保存真实实库8条绑定一致、两组4名称结果与原图库相同、其他主体不能读取这些绑定、隔离倒序回滚、0外部请求/0补图入队。
- 实城身份及图片分配从真实库读取；回滚和写入只在专用临时库验证。没有回滚实库首批，也没有写应用用户行程。两次临时库均已由runner正常清理。

## 剩余工作

逐提及关系挖掘与稳定身份端点仍未实现。上游最新实城消费仍是flow/run-26（243正例/113独立包含/4撤回，0失败，12未导出负例单列）；审核仍audit/run-23（138实体对uncertain、4提及待审）。本轮没有改变上游身份，不重复运行全部上游测试，也不把独立图库8张通过扩大为全城归一验收。

先核实三组跨目录身份差异，再推进逐提及关系及剩余混合来源补证。Goal active，任务in_progress，用户未验收，不提交、归档或标记完成。
