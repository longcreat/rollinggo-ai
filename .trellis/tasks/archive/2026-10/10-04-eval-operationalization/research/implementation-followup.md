> 已于 2026-10-05 获用户明确授权提交并归档。当前状态为 completed，详见[验收与归档记录](acceptance.md)；下文保留实施阶段记录。

# 日期排程与营业归属修复：实施交付

2026-10-05。用户已授权实施两份方案，并在审阅成都 v2 预览后回复“可以，继续”。代码与 402 条生产营业字段修复已应用；**等待最终交付验收，未提交、未归档、未接纳基线**。

## 实施结果

- `scheduling/dateRepair.ts`：整天日期匹配后，对仍闭馆的已选景点做有界跨日移动/交换。保留景点、容量和独占日，故宫→景山等同天先后组合一起移动；重算日内顺序后才按实际日期选餐。几何距离上限为原路线总长增加不超过 max(2 km, 10%)；这不等于真实路网耗时保证。
- `schedule.ts` / `buildDraft.ts` / `orchestrator.ts`：取消“整段闭馆就删掉并存自由日”的降级。未解决冲突带日期、地点、原因，写草稿前失败；地理后处理后还会复核闭馆。真实 HTTP SSE 只发布一次失败，数据库无新行程或成功配额。
- 上游 `app/clean/hours.py` / `scripts/export_to_tripweaver.py`：营业提取改为目标实体、别名、原句、来源、作用范围记录；先拆实体与子设施，再解析时间。未知主体只留待审，明确博物馆的闭馆日仍保留。原句保留完整，来源链接不携带签名参数。导出使用只读一致性事务。
- `placeFacts.ts`：v2 待审/子设施字段不渲染为主地点营业规则，也不能从旧 evidence 的无主语正则重新回填。

搜索为确定性有界启发式：30,000 次尝试、256 个展开状态、16 个候选状态；仅接受闭馆数量下降的移动。失败区分全程无开放日、搜索空间耗尽、搜索上限，不能把它解释成对所有可行路线的数学证明。

## 验证结果

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 原北京“避远郊”输入真实重跑 | 1/1 PASS；hard 0、soft 0 | [报告](../../../../../../eval/runs/date-retest-1791169501846/avoid-remote/2026-10-05T03-05-02-502Z-35e07223/report.md) |
| 原北京“本地美食、不辣”输入真实重跑 | 1/1 PASS；hard 0、soft 0 | [报告](../../../../../../eval/runs/date-retest-1791169501846/food-no-spicy/2026-10-05T03-05-33-767Z-59c681d7/report.md) |
| 北京 3/5 日 × 无偏好/美食/历史/自然 | 8/8 PASS；hard 0、soft 3 | [报告](../../../../../../eval/runs/date-retest-1791169501846/beijing-matrix/2026-10-05T03-06-13-120Z-45e8313b/report.md) |
| 成都候选修复知识版，3 日美食 | 1/1 PASS；hard 0、soft 1 | [报告](../../../../../../eval/runs/hours-preview-2026-10-05-v2/live/2026-10-05T03-20-46-550Z-d2f77f33/report.md) |
| 成都实际应用后知识版，3 日美食 | 1/1 PASS；hard 0、soft 0 | [报告](../../../../../../eval/runs/hours-applied-live-2026-10-05/2026-10-05T04-12-38-530Z-6f873112/report.md) |
| 原 96 例候选 + 同版冻结知识，重新执行排程 | 96/96 无闭馆冲突、结构完整 | [回放 JSON](../../../../../../eval/runs/date-replay-1791169006716/report.json) |
| 当前完整流程（含生产构建、首页和详情浏览器） | 12/12 PASS | [流程报告](../../../../../../eval/runs/flow-2026-10-05T03-12-13-907Z/flow-report.md) |
| 生成相关单测 / 评估单测 | 255/255、46/46 PASS | 流程报告内 generation-units / eval 日志 |
| 上游营业、图片导出、内容关联测试 | 49/49 PASS | 下方复现命令；仅既有 zhconv 弃用提示 |
| 候选知识隔离导入、回导、检索和向量 | PASS，三表 hash 一致 | [验证](../../../../../../eval/runs/hours-preview-2026-10-05-v2/candidate-verification.json) |
| 类型检查 / 差异空白检查 | `npm run typecheck`、`git diff --check` PASS | 本轮执行 |

上述 12 次真实生成使用同一份当前应用代码。北京仍使用原 `kb-2026-10-05-matrix`；成都先验证独立候选修复版，再验证生产源库实际更新后导出的新版本。两次成都结果独立保留。真实天气和照片新增查询仍按原评估配置关闭，相关功能由 mock 流程验证。

## 原失败的确定性对照

另取两份原最终行程的景点和坐标验证跨日修复，分别保留全部 **12 个、10 个景点**，不删故宫、不删空天，故宫和景山一起移到周三。以下是景点间直线几何总长，未包含餐次、住宿或真实路网：

| 场景 | 原总长 | 修复后 | 周一景点 |
| --- | --- | --- | --- |
| 避远郊 | 32.81 km | 30.56 km | 南锣鼓巷、鼓楼、什刹海、北海公园 |
| 本地美食、不辣 | 27.10 km | 24.33 km | 北海公园、什刹海、鼓楼、雍和宫 |

逐天地点、原路径、保留 ID 数量及搜索次数见回放 JSON 的 `focused`。这份固定景点修复与上表真实重新生成是两种证据，不能互相冒充。

96 例回放使用原候选/表单、冻结库事实、分量、关系与知识坐标重新调用排程，**历史未保存 research.locations**，所以不能称完整复现原调研坐标条件。原最终 Trip 重评分没有被当成当前排程回归。原始生成报告仍为 93 PASS / 3 FAIL，没有改成全绿。

## 已应用的数据修复

应用依据为已展示的 [成都营业信息预览](../../../../../../eval/runs/hours-preview-2026-10-05-v2/preview.md) 与对应逐行 JSON。

- 当前上游导出 404 地点；映射原冻结版后 **402 行**营业元数据变化，其中 **25 行**营业字段变化、377 行仅增加归属元数据。
- 奎星楼街：旧“周一闭馆”→未知，现有来源不足以确认它全天开放；不拿“奎星街”未经确认的别名替代。
- 锦里：旧“全天开放 + 周一闭馆”→保留明确归于锦里古街的全天开放证据，移除他馆闭馆；成都博物馆自身的周一闭馆继续保留。
- 金集行的顶层 `openHours` 可能是上游补充，不能把行级 `source=goldset` 当成字段归属。预览包含 8 个这类地点的上游营业字段，原金集 activity/来源身份及其他字段不动。
- 原知识 hash `f5a31c5092769d093bbcd4f6eca7e265c3111b480d42c238b02be9b89b9cb3c6` 保持不变。新候选版为 `kb-2026-10-05-hours-preview-v2`，完整 hash 在预览中。
- 地点 ID、坐标、独立证据、关系和向量均保持不变。当前向量输入不含营业字段，因此无需重建；隔离导入回导已验证。该冻结副本本就不含图库资产，不用它验证或覆盖生产图片。
- **实际应用完成。** [只读预检](../../../../../../eval/runs/hours-preflight-1791173367779/result.json) 中 402 行身份与原值全部匹配；[应用结果](../../../../../../eval/runs/hours-apply-1791173395975/result.json) 更新 402 行，独立事务读回通过。
- [更新前备份](../../../../../../eval/runs/hours-apply-1791173395975/backup.json) 保存字段原值、原键是否存在和其他字段 hash，在 SQL 更新前以独占新文件写入并 fsync。更新使用 serializable 事务及行锁，原值不匹配、备份失败、更新异常或其他字段变化均回滚。
- [独立读回与全量差异核对](../../../../../../eval/runs/hours-apply-1791173395975/verification-1791173546137.json)：实际源库新导出与批准候选内容 hash 完全相同；原冻结副本未变；地点其他导出字段、独立证据、关系和向量完全相同。源库 402 行的非营业字段 hash 与备份一致，覆盖图片和原金集 activity。未读取用户历史表，补丁 SQL 仅更新 `canonical_places.payload.openHours`。
- 新版 [kb-2026-10-05-hours-applied](../../../../../../eval/knowledge-snapshots/kb-2026-10-05-hours-applied/manifest.json)，hash `c31ccf5a1d3ac19c3c2d039db4c07a466ebf7a80400cbec1d3f47ef8e05b7237`；5,021 地点、7,102 证据、270 关系，12,123 条 1024 维向量。[隔离导入、回导、各城市检索及向量查询](../../../../../../eval/runs/verify-knowledge-1791173500003/verification.json) 全部通过，专用数据库已清理。
- 定向补丁的 12 组真实 PostgreSQL 合成检查通过，覆盖不存在/显式 null 字段、身份与原值漂移、备份失败、SQL 异常及图片旁路修改回滚、完整读回、删除键和重复应用幂等。
- 补丁与应用/读回脚本通过独立 TypeScript 检查；`git diff --check` 通过。本次未改变产品代码，因此复用上轮完整流程验证，追加实际新知识版成都单例（约 30.8 秒，hard 0、soft 0）。
- 更正此前导入说明：`reconcileImportedPlaces` 在有效 identity 元数据下会替换 xhs/goldset 的 `openHours`；不能仅凭最初合并顺序断言旧值一定保留。选择定向补丁是为了限制本次影响范围，全量导入还会改内容、身份、独立证据等字段。

首次预览误把所有金集行的营业字段排除，已保留为历史产物；以链接中的 **v2** 预览为本次交付。

## 复现与剩余限制

```powershell
npm run typecheck
node --import tsx --test apps/server/src/__tests__/dateRepair.test.ts apps/server/src/__tests__/scheduling.test.ts apps/server/src/__tests__/mealLocality.test.ts
$env:EVAL_PG_ADMIN_URL = 'postgres://postgres:postgres@127.0.0.1:5432/postgres'
npm run eval:flow
# 同一工作区已有原知识/原96例产物时，创建新的排程回放目录
node --import tsx .trellis/tasks/archive/2026-10/10-04-eval-operationalization/research/replay-date-scheduling.mts
# 定向补丁自测自建/清理隔离库；下面两条只读核对已应用的源库与历史证据
node --import tsx .trellis/tasks/archive/2026-10/10-04-eval-operationalization/research/test-hours-patch.mts
npx tsc --noEmit -p .trellis/tasks/archive/2026-10/10-04-eval-operationalization/research/tsconfig.hours-patch.json
node --import tsx .trellis/tasks/archive/2026-10/10-04-eval-operationalization/research/verify-hours-applied.mts
node --import tsx .trellis/tasks/archive/2026-10/10-04-eval-operationalization/research/audit-implementation.mts
# 在上游仓库根目录，使用其 venv
.venv/Scripts/python.exe -B -X utf8 -m pytest tests/test_hours.py tests/test_hours_attribution.py tests/test_image_export.py tests/test_place_content.py -q -p no:cacheprovider
```

前一轮真实复测的 4 项 soft 观察保留：北京矩阵 3 项、成都候选版 1 项；成都为 D2 餐厅→春熙路→东郊记忆的折返。实际应用后独立成都复测 soft 0，不反向改写候选版观察或宣称该问题已被新代码解决。本轮解决日期冲突与事实归属，不宣称全路线最优，口味/过敏等要求也不因名称命中而获得独立事实验证。

最终 [应用后交付审计](../../../../../../eval/runs/hours-apply-1791173395975/delivery-audit-1791173671351.json) 核对当前源文件与 12 次真实运行/流程 hash、96 份原快照、原冻结知识、402 行应用结果、新知识回导与任务仍为 in_progress。原 [预览阶段交付审计](../../../../../../eval/runs/date-retest-1791169501846/delivery-audit.json) 保留当时未应用的事实。所有验证进程已结束。
