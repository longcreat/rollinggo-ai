# 新实体创建入口实施记录

## 当前状态

新实体创建、无主源实体导出、后续来源事实隔离和候选所有者约束已安装；仅新增`place_identity_scope.withdrawal_entity_ids`可空列，未创建任何实城新实体。实库治理仍截至batch25，禁止重放。任务未获用户验收，不提交、归档或标记完成。

## 契约

见`scoped-entity-creation-design-20261007.md`。`newEntities`在逐提及范围事务中创建稳定ID，核对每条当前原文quote和inputHash；明确分店名或紧随地址形成的限定展示名可用。每个别名须有证据，不得抢占现有主名、来源名或旧ID。后续普通注册、bootstrap和别名认领同样不能复用已回滚创建的ID。

新实体无primary_place_id，独立导出只取自身overrides和已审核提及；日后有同名member也不借其位置、行政区、简介或旧图片。来源成员不等于旧泛名候选所有者：已有目标后来纳入来源范围时不能继承其他分店候选。新列冻结该角色，旧null和旧快照保留兼容；扩展/回滚不回填历史审计。

## 已验证

- 地址限定名、跨店拼接拒绝及连续回滚首轮184通过：`upstream-stage-place_identity_test_1791341731112.log`。
- 真实SQL复现后续来源误继承候选：`upstream-stage-place_identity_test_1791341841918.log`，1失败/184通过，失败保留。
- 修复后完整414通过；追加普通注册/首次注册历史ID保留反例后最终**416通过**：`upstream-full-place_identity_test_1791342326139.log`。
- 23旧批次隔离幂等/倒序回滚：`scope-batch-regression-1791342210948.json`，23/23；此验证在最后补历史ID注册保护前，最终完整416覆盖后补保护。
- batch24暂存兼容：`all-cities/batch-24/scope-preview-1791342241026754800`。batch25：`all-cities/batch-25/joint-preview-1791342240050440800`。均原文不变、幂等、导出和倒序回滚通过；没有实库重放。
- 新创建真实上游导出序列：`all-cities/entity-creation/run-1791342217111048800/report.json`。初态仅1旧主体，随后新建2独立分店、旧ID撤回、全空、恢复；无坐标不借旧值。
- 真实下游导入脚本→SQL检索→事实→行程保存/读回/编辑→全空撤回/恢复→倒序审计通过：`downstream-place_identity_test_1791342237800.log`。旧联合来源工件复核通过：`downstream-place_identity_test_1791342521485.log`。
- `tsconfig.verify-joint.json`与全仓`npm run typecheck`最终退出0。研究脚本曾对unknown payload错误访问字段、再错误从shared导入asRecord，均已修为实际chat/models导出；不是产品缺陷。
- 以上runner正常结束，临时数据库清理；没有实城模型、地图、浏览器端全产品E2E声明。

## 安装和迁移证据

- 41暂存文件中10变化已按哈希安装；`upstream-install-creation-20261007.json`。安装后预览changed=0。逐版本备份保留。
- `creation-scope-migration-1791342604594324300.json`：首次仅缺新列，二次missingColumns=[]。8治理表迁移前后行数据哈希一致：实体5865、成员5870、审核489、审计505、scope4、scope_source4、assignment7、image_assignment0；旧scope新列全null。
- 没有新实城批次、待同步步骤或生产内容变更；不把“功能可用”当作原始门店关系已确认。

## 实城补证与未完成事项

- `split-sources-1791342610613944900.json`新冻结西安同品牌3源/5提及/0图片。12138只写总店；11752明确端履门城市之心1层6号；12319明确钟楼店；11826与12313仍无分店。
- Trip.com店铺页`aihua-address-trip-20261007.md`明确总店地址与11752一致，提示必须核对并尽量复用现有总店ID，不能为地址展示名再造主体。原地图南广济街与东三道巷不作为同店证据。
- `aihua-bell-search-20261007.json`主生成文本含不存在的“钟楼区”，无primary_sources，不能采信。extra_sources中新浪给南大街5号，但文章fetch为空、问答URL实际返回门户首页，均不证明具体分店地址。检索摘要不是已验证正文。
- 钟楼店与总店关系仍待可靠正文/原图互证；未生成batch26请求。北京654路线证据也未形成具体分店门牌，不作整源改名。
- 独立图库逐图绑定、逐提及关系挖掘仍未实现；全城138实体对uncertain及4提及待审仍按batch25后的audit/run-23记录，不算已解决。

## 原图补证（本轮最后追加）

`all-cities/aihua-note-refresh-01.json`通过现有采集客户端重取2656/2675/2678/2712，四篇正文不变。首次从tripweaver目录运行因未加载上游Cookie而失败、未发请求；改用上游工作目录后成功，没有要求用户重配凭据。

`all-cities/xian-aihua-images-01/manifest.json`保存35/35张原图哈希；四张contact表已逐张核看，2656-p04与2678-p04另外看原图。2656-p04有爱骅门头及端履门城市之心1层6号；2678-p04写“总店”但只有食物照、无门牌；2675三张美食清单仍只有品牌；2712十六张主要是景点/人物与崇德楼餐食，没有爱骅门头或票据。照片来自任务取证，未导入产品图库，也未修改原始提及。

`aihua-bell-map-search-20261007.json`90秒超时；按网络失败要求在沙箱外重试的`aihua-bell-map-search-retry-20261007.json`120秒也超时，均无来源结果，不继续重复同一检索。新浪文章fetch为空、问答URL跳门户已留失败工件。下一步可从新证据评估11752复用现有总店身份及错坐标清理；钟楼店的不同分店结论仍不可据此补造。

当前没有运行中session、待审批或待同步，Goal active；完整任务未验收。
