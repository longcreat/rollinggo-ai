# PRD：调研阶段知识库 RAG 优先，网络搜索降级为兜底

- 任务：`09-20-research-rag-first`
- 创建：2026-09-20 / aimer
- 优先级：P2
- 关联：`09-18-postgres-migration-rag-foundation`（RAG 地基，已落地 `retrieveContext`）

## 背景

调研阶段（`orchestrator.ts` 阶段 1）目前并列暴露 5 个工具，prompt 把知识库（`search_verified_places`）当成「先查一下」的第一步，随后仍要求 `search_pois` 分类搜索 + `search_web` 查预约/玩法 2~5 次。结果是：社区已验证地点库（`canonical_places` + `research_evidence`，小红书口碑治理产物）的价值被稀释，网络搜索成为默认主力，每次生成都要烧搜索额度与 token。

目标是把调研的默认信息源切回自有知识库，网络搜索退化为「知识库确实补不上」时的兜底手段。

## 目标（In Scope）

1. **调研 prompt 重写工序**（`apps/server/src/generation/prompts.ts` 的 `RESEARCH_SYSTEM_PROMPT`）：
   - 第 0 步且为唯一必做检索步骤：`search_verified_places` 按行程主题/偏好检索（多次、多关键词角度），命中地点优先 `add_candidate`
   - 知识库命中足够（覆盖景点/美食/住宿三类基本盘）时，**不再调用** `search_web`
   - 仅当知识库连续无命中/命中明显不足时，才允许 `search_web` 兜底，且**全阶段 ≤2 次**
2. **工具语义降级标注**（`apps/server/src/generation/tools/researchTools.ts`）：
   - `search_web` 的 `description` 改写为明确的兜底定位（"知识库无命中时才用"），模型选工具时读的就是这段
3. **空命中提示改写**：`search_verified_places` 当前返回「请用 search_pois/search_web 补充」，改为「请换关键词再查知识库；确实无命中时才用 search_web 兜底」

## 非目标（Out of Scope）

- 不动 `retrieveContext.ts` 的混合召回算法（关键词 + 向量合并、top 8、evidence 挂载规则保持不变）
- 不动 `search_pois`（高德）：它提供坐标旁路与 `coverUrl`，属地点事实源而非攻略搜索，保持现状
- 不做「编排前预检索决定是否挂载 search_web」的动态工具裁剪（多一次前置查询，且工具列表随数据波动，收益不抵复杂度）
- 不改 `searchBudgetRemaining` / `createTaskSearchSource` 的额度与凭据机制

## 已确认的解读（用户未逐条回答问卷，按最合理读法执行）

| 议题 | 决定 | 理由 |
| --- | --- | --- |
| `search_pois` 去留 | **保留** | 去掉会丢失坐标旁路（长途点判定）与 `coverUrl`，得用 geocodeAll 全量补，代价更大 |
| 降级触发方式 | **prompt 指示 + 工具描述**，工具常驻 | 改动最小、可回滚、不引入工具列表的动态不稳定性 |
| 末级兜底 | **模型自身知识仍可用** | 摘要中继续注明「（部分/全部来自模型知识）」，保持现状行为 |

## 验收标准

- [ ] `RESEARCH_SYSTEM_PROMPT` 中 `search_web` 出现位置为「兜底」语义，并带次数上限
- [ ] `search_web` 工具 `description` 明确写「仅当知识库无命中时使用」
- [ ] `search_verified_places` 空命中提示不再把 `search_web` 列为并列选项
- [ ] `npm run typecheck` 通过
- [ ] 现有单测通过（`generationTimeline` / `generationPerformance` 等只引用工具名字符串，不受影响）
- [ ] `npx tsx apps/server/test-beijing-rag.mts` 可复跑，`search_verified_places` 调用次数不低于 `search_web`

## 风险

| 风险 | 缓解 |
| --- | --- |
| 知识库覆盖不足的城市，候选池数量掉到数量指引以下 | prompt 保留「不足时兜底」路径；末级还有模型知识，不会空池 |
| 模型无视 prompt 仍提前调用 `search_web` | prompt 纪律属概率性约束；任务级 `SEARCH_MAX_PER_TASK = 10` 是硬上限兜底 |
| 与 eval 金集复现性冲突 | 本次只改调研阶段 prompt；planner prompt 的「空 RAG 结果逐字不变」契约未触碰 |

## 工作量

约 20–30 分钟（3 处文本修改 + typecheck）。
