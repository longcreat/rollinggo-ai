> 已于 2026-10-05 获用户明确授权提交并归档。当前状态为 completed，详见[验收与归档记录](acceptance.md)；下文保留实施阶段记录。

# 最新执行检查点（2026-10-05 成都营业预览应用后）

用户已明确“开始实施修改”，两份大改已实施；审阅 v2 预览后又回复“可以，继续”，402 条营业修复已应用。当前等待最终交付验收，未提交、归档或接纳基线。不要按下方旧记录继续等待实施或数据应用授权。

- 交付入口：[实施与验证](implementation-followup.md)。
- 北京原两失败 + 3/5 日四偏好真实复测 10/10 PASS；成都候选版 1/1 PASS、实际应用后新版 1/1 PASS。共 12 例 hard=0，soft=4；最新成都 hard=0、soft=0，原 96 例报告不改。
- 96 例原候选+冻结库当前排程回放无闭馆冲突；缺历史 research.locations 的限制已列明。原两失败分别保留 12/10 景点重组成功。
- 完整 eval:flow 12/12 PASS，生成相关单测 255、评估 46；上游最终关联回归 49/49；typecheck、diff-check PASS。
- 已应用 `eval/runs/hours-preview-2026-10-05-v2/preview.md`（402 行变更、25 行营业值变化、377 行仅归属元数据），包括 8 个金集行的上游补充。预检 402/402 与原值一致；备份、事务结果和独立读回在 `eval/runs/hours-apply-1791173395975/`，图片/原金集 activity/其他字段受非营业字段 hash 保护。
- 新版 `kb-2026-10-05-hours-applied` hash `c31ccf5a1d3ac19c3c2d039db4c07a466ebf7a80400cbec1d3f47ef8e05b7237` 与候选完全相同；原冻结版不变。三表与全部 12,123 向量隔离验证通过：`eval/runs/verify-knowledge-1791173500003/verification.json`。
- 最新成都真实报告：`eval/runs/hours-applied-live-2026-10-05/2026-10-05T04-12-38-530Z-6f873112/report.md`。新交付审计：`eval/runs/hours-apply-1791173395975/delivery-audit-1791173671351.json`；原审计不覆盖。
- 定向数据补丁 12 组 PostgreSQL 检查、独立 TypeScript 检查通过。本次未改产品代码，原完整流程对应当前源文件的 hash 校验通过。
- 新源文件在 `generation/scheduling/dateRepair.ts`，冲突在 buildDraft 写入前及 orchestrator 保存前均拒绝；上游四文件已经定向安装。
- 所有进程已退出；后续按具体验收反馈继续，勿重跑旧矩阵或改写旧 FAIL。

---

# 历史执行检查点（以下“等待实施确认”已过期）

**本节覆盖下方历史检查点。所有进程已结束，勿根据旧记录继续等待或重跑。**

任务 in_progress、goal blocked（等待用户实施确认）；未提交、未归档、未接纳新基线。原交付及两次自动续接均未收到大改确认，已完成证据复核，没有剩余可独立推进的必要工作。收到明确确认后再恢复对应方案实施。

## 当前交付

- [总验证报告](../../../../../../eval/runs/campaign-2026-10-05-live-matrix/validation-report.md)
- [日期排程方案](date-scheduling-proposal.md)与[营业信息归属方案](knowledge-attribution-proposal.md)：均未实施，依用户“大改先文档等确认”要求等待确认。
- 原生成基线 **96/96 执行，93 PASS、3 FAIL**，主 session 18002 exit 1。两个北京备注场景的周一故宫闭馆仍未修。
- 语义 watch 52925 exit 0；23/23 组 VALID，79 aligned / 17 mixed；最终采用 semantic-audit.md/json（含 v1/v2 复核）。
- 可选地点 4705，候选覆盖 430，最终行程覆盖 319，完全未覆盖 4275；summary/ 下有全清单。
- baseline-runtime-verification.json 已验证原 96 例期间产品代码未变；下面的小修在基线结束后实施。

## 已完成小修

1. chat/brief.ts：travel_qa 忽略全部字段和约束增删；明确空 extraNotes 清空，旧无 intent patch 保留。
2. chat/prompts.ts：修改/取消备注同步清理旧内容与相反约束、保留其他要求，移除过时预算说明。
3. schedule.ts：餐厅按实际分配日期过滤闭馆候选，被拒候选保留；核心景点跨日分组尚未改。

## 修复后验证

均在活动 eval/runs/campaign-2026-10-05-live-matrix 的 retests-small-fixes/ 下：

- chengdu/2026-10-04T17-52-39-360Z-8cb4ad77：真实成都 3 日美食 **1/1 PASS，hard 0 soft 0**；session 56118 exit 0。
- readonly-decision-replay.json：原两个 QA 失败 decision **2/2 PASS**。research/replay-readonly-decisions.mts 可复现，禁止覆盖已有回放。
- intent/2026-10-04T17-52-27-981Z-5997d56c：中间 39/40；FAIL 为添加已有天坛时模型合理澄清的 fixture 歧义，不是产品缺陷。原报告保留。
- intent-context-v2/2026-10-04T17-56-45-566Z-695eaac6：改用未出现的玉渊潭并补 fixture 回归，完整 **40/40 PASS**；session 68010 exit 0。
- 完整流程 eval/runs/flow-2026-10-04T17-56-56-425Z：**12/12 PASS**（含生产构建、首页及详情浏览器），session 49654 exit 0。
- flow 内 eval 测试 **46/46**、generation 单测 **246/246**；针对 Brief/餐次/排程回归 **57/57**。
- npm run typecheck PASS；最终 fixture 修改后 npx tsc --noEmit -p eval PASS；git diff --check PASS（仅换行提示）。
- 知识导入/回导/向量验证见 eval/runs/verify-knowledge-1791133378979/verification.json；三表内容、查询与专用库清理通过。
- 所有 live/意图/审阅/flow 进程已退出，live.lock 与 campaign.lock 不存在。

## 后续须保留

- 自动续接已执行 audit-current-evidence.mts；新增 evidence-audit-1791137303012.json，96 份快照、覆盖统计及两套当前运行 hash 一致。没有收到大改确认；未改应用代码、未重复调用真实模型。目标保持 active。
- 不把原 96 例改成全绿；两个北京排程失败、上游营业归属仍待方案确认。
- 17 个 mixed 及 11 个活动间交通至少 4 小时的日期如实保留，最长 534 分钟，不含游玩与住宿。
- 苏州/西安/青岛是 API 降级路径；饮食/过敏/免爬坡/未知营业事实未完整核实。
- 不将 goal/task 标完成，不提交或归档。用户说“继续”不等于验收确认。

---

# 历史检查点（已过期，仅保留过程记录）

2026-10-05。本轮用户授权真实模型、全城市不同偏好、备注与意图测试；云南排除；大改先文档等确认。任务/goal 尚未完成，未提交、未归档。

## 正在运行

- 主活动命令 `npm run eval:campaign -- --knowledge-snapshot eval/knowledge-snapshots/kb-2026-10-05-matrix --out eval/runs/campaign-2026-10-05-live-matrix`。
- 主工具 session **18002**，最后确认运行到苏州。活动 12 批：11 城各 8 例 + 北京 notes 8 例，共 96 次。前 64 例为 63 PASS、成都 3 日美食 1 FAIL。
- 原语义审阅 watch 工具 session **52925**。读取主批次完成结果，默认 23 组。它是在旧审阅校验/2 轮参数下启动，后续代码已加严格 ID 正文校验和 4 轮修复，不会自动影响旧进程。
- 广州 5 日审阅复核 session **67252**，输出 `semantic-recheck-v2`，待取完成结果。

## 已结束与关键产物

- 最新冻结库 5,021 地点（新增济南）、7,102 证据、270 关系，contentHash `f5a31c5092769d093bbcd4f6eca7e265c3111b480d42c238b02be9b89b9cb3c6`。云南 138 条排除生成；其余 4,883 条计覆盖。
- 全量隔离导入、回导 hash 和向量查询通过：`eval/runs/verify-knowledge-1791133378979`（session 45343 已 exit 0）。
- 首轮意图 16 × 2：`campaign-2026-10-05-live-matrix/2026-10-04T16-52-53-763Z-ef1eb0a0`，30 PASS / 2 FAIL，真实 QA 带 addConstraints，服务端当前无保护。
- 意图已扩为 20 场景，最终复测应是 **40 次**。新增取消自由备注 trial `2026-10-04T17-17-36-153Z-607bad9e` 的第二次 FAIL 是检查器误把“取消不去故宫限制”当作仍禁止；已修正 `palaceRestrictionRemoved` 并加回归，需用现有观察重新判定或最终完整复测。
- 更新饮食备注 trial `2026-10-04T17-20-56-897Z-ac1585f4`（session 15051 已结束）两次真实失败：新约束“现在可以吃辣”与旧 extraNotes“不能吃辣”并存。
- 厦门 5 日审阅首次工具轮次超限；`semantic-recheck-v1/xiamen-5d.json` 已成功（session 86383 exit 0）。
- 严格审阅 audit 命令：`npm run eval:campaign:audit -- --campaign <活动目录> --reviews semantic,semantic-recheck-v1,semantic-recheck-v2`。在新增缩写 ID 校验后，旧广州 5 日正文串用了别例短 ID，因此需要 v2 复核。最后 audit 13 VALID、1 ERROR、9 PENDING。
- 聚合报告：`npm run eval:campaign:report -- <活动目录>`，`summary/report.md` + 全部 ID、未覆盖与未入选清单。只读已经 finalized 的批次，运行中的批次保持 PENDING。
- `npm run eval:test` 最近完整 **44/44 PASS**（后又新增 1 个取消语义测试，当前应 45）；相关子集通过，类型检查最近通过。最终仍需完整检查。
- 一份矩阵离线回放通过，位于活动 `replays/`。

## 产品小修尚未做（等主基线结束，保持基线代码一致）

1. `apps/server/src/chat/brief.ts` 的 `applyDialogueDecision`：对 intent=travel_qa 忽略所有 Brief 增量，保持原值；加真实观察回归，兼容未带 intent 的已有纯 patch 调用。
2. `apps/server/src/chat/prompts.ts`：用户修改/取消原 extraNotes 要同步更新该字段并保留未涉及条件，不可仅追加相反新约束；纯问答不附带变更。当前还残留“改预算去编辑器”的过时句子，可小幅删除预算部分。
3. `apps/server/src/generation/scheduling/schedule.ts`：`takeMealAnchor`/`selectMealStop` 增加可选日期，过滤 `isClosedOnDate`；buildSchedule 按实际 assigned target day 传日期，关闭候选留在集合供可用日再选。已导入 `dateForDayIndex`/`isClosedOnDate`。给 mealLocality 加 Monday/Tue/无日期/真实分配日回归。
4. 小修后用原失败实际 decision 复放、真实意图 40 次、成都 food 失败单例真实重跑、适当其他受影响场景及完整 `eval:flow`（需要主 live 结束释放锁）验证。不修改旧报告，不把重跑当原报告改绿。

## 较大修改需等待确认

`research/knowledge-attribution-proposal.md` 已有具体代码依据和方案，涉及上游 `D:/Project/xhs-travel-pipeline/app/clean/hours.py` 与 `scripts/export_to_tripweaver.py` 的证据主体绑定及数据修复预览。尚未修改上游或生产知识库。成都奎星楼街、锦里把“物馆周一不对外开放”挂为自身营业规则。先完成已授权测试再交付方案，请用户按其指示确认大改。

## 待完成

- 等 96 次主生成和原 watch 全部结束，检查所有失败/notes 约束问题，必要的大改只给方案。
- audit 全部语义组，显式新目录复核失败/串例引用组。审阅标签只是线索，已有人工核查证明模型正文可串例，不可当事实。
- 完成小修与实际回归，复测 40 意图，执行完整本地流程/typecheck。
- 更新完整报告/验证记录：基线计数、修正后复测、语义结论、同城差异、各城市候选/入选覆盖、全部未覆盖 ID；标明低覆盖城市苏州/西安/青岛属于 API 降级路径而非当前首页可选城市。
- 最终对照用户全部要求审计；测试未结束不能 final 声称完成。用户验收前不提交/归档/标任务完成。
