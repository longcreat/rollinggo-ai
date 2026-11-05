# place identity 收尾 + 测试隔离

## Goal

`10-06-place-identity-governance` 于 2026-10-12 归档（`ac8ebfb`），但归档后 15:12–17:00 又产生了 5 个文件的工作区改动，既没有任务记录也没有提交，处于「无人认领」状态。本任务把这些收尾改动纳入正式流程：确认每处改动的正确性、补齐缺失的验证证据、跑通隔离库测试入口，然后提交。

## What I already know

工作区改动（`git status --porcelain -uall`，2026-10-12 写入，晚于归档提交）：

| 文件 | 改动性质 |
| --- | --- |
| `apps/server/src/generation/tools/researchTools.ts` | 修复：库内坐标命中时直接 `locations.set` 覆盖同名搜索结果坐标，不再走 `rememberResearchLocation` |
| `apps/server/src/__tests__/placeLookup.test.ts` | 测试隔离：新增 `identityPlaces` 显式注入 `verifiedPlaces`，封面用例断言改为「已知实体用库内正式名」（故宫→故宫博物院、天坛→天坛公园） |
| `apps/server/src/__tests__/placeFacts.test.ts` | 去脆化：`payload.openHours` 断言从硬编码 `06:30-20:00` 改为正则 `^\d{2}:\d{2}-\d{2}:\d{2}$` |
| `scripts/verify-sql-first.mts` | `--full` 时排除 `independentPhotoIdentity.test.ts` |
| `scripts/verify-place-identity.mts`（新增，未跟踪） | 专用 runner：建 `place_identity_test_<ts>` 库后跑身份/图片链路测试 |

`researchTools.ts` 那处修复的机理（已核对 `apps/server/src/generation/placeLookup.ts`）：

- `rememberResearchLocation` 的歧义检测是为「多个搜索结果撞名」设计的：同名坐标不一致时 `locations.delete(key)` 并写入 `ambiguousNames`
- 把库内权威坐标喂进去，会因与搜索结果坐标不一致而删掉整个 key，连搜索结果坐标一起丢，使层2 坐标旁路失效
- 新写法先 `ambiguousNames.delete(locationKey)` 再 `locations.set(...)`，语义是「库内坐标权威覆盖」

`independentPhotoIdentity.test.ts` 自身硬约束（`apps/server/src/__tests__/independentPhotoIdentity.test.ts:34`）：

```ts
assert.match(process.env.DATABASE_URL ?? '', /place_identity_test_\d+/);
```

- 这是 `verify-sql-first.mts`（库名 `tripweaver_sql_first_<ts>`）无法包含它的原因
- `verify-place-identity.mts` 用同一命名契约建库，且把外部能力环境变量清空（`AMAP_KEY`、`PEXELS_API_KEY`、`EMBEDDING_*` 等），不加载应用 `.env`

## Assumptions (temporary)

- 这些改动是上一轮（或并发会话）有意留下的收尾，而不是半成品废弃代码 —— 待用户确认
- `researchTools.ts` 的修复只影响「库内已有坐标」分支，不改动搜索结果自身去重逻辑

## Open Questions

（无，两个问题已在 brainstorm 阶段收敛）

## Requirements (evolving)

- 工作区 5 个文件全部纳入本任务，不再游离
- 每处改动都要有可重复的验证证据（typecheck / 单元测试 / 隔离库集成测试）
- 测试应在隔离空库中成立，不依赖真实应用库的数据（`故宫博物院`、`openHours` 时段等）
- **新增回归测试**：锁定 `researchTools.ts` 的「库内坐标权威覆盖同名搜索结果坐标，且 key 不被歧义检测删除」行为（用户已确认）
- **维持双 runner**：保留 `verify-place-identity.mts` 专跑 `place_identity_test_<ts>` 契约的测试，`verify-sql-first.mts --full` 继续排除 `independentPhotoIdentity.test.ts`（用户已确认）

## Acceptance Criteria (evolving)

- [x] `npm run typecheck` 通过（全仓四包，无输出即无错）
- [x] `placeLookup.test.ts`、`placeFacts.test.ts` 在隔离空库下通过，且失败原因与真实库数据无关
- [x] `scripts/verify-sql-first.mts --full` 不再因 `independentPhotoIdentity.test.ts` 失败
- [x] `scripts/verify-place-identity.mts` 独立跑通并清理临时库
- [x] `researchTools.ts` 的坐标覆盖行为有新回归测试覆盖，且该测试在旧实现下会失败（能证伪）
- [x] 新增用例不依赖真实应用库数据，可在隔离空库中跑

## Verification Evidence (2026-10-12)

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| typecheck | `npm run typecheck` | 通过 |
| 单元（新用例） | `node --import tsx --test src/__tests__/placeLookup.test.ts`（apps/server） | 20/20 |
| 证伪 | 临时把 `researchTools.ts` 换回 `rememberResearchLocation` 后重跑 | 新用例 ✖，另有 4 个封面用例 ✖；还原后绿 |
| 隔离库全量 | `node --import tsx scripts/verify-sql-first.mts --full` | 639/639，exit 0，库已 drop（守卫修复后重跑） |
| review 后续修复 | 补 `isUsableResearchLocation` 守卫 + 0,0 脏值用例（P2） | typecheck 通过，20/20 |
| 隔离库 flow | 同上 `--flow` | 267/267，exit 0 |
| 身份/图片 runner | `node --import tsx scripts/verify-place-identity.mts` | 22/22，exit 0，库已 drop |
| 临时库残留 | `pg_database` 列举 | 无本次残留（`place_identity_test_1` 为历史手工库，未动） |

## Definition of Done (team quality bar)

- 测试新增/更新（若采纳补回归测试）
- typecheck / lint 通过
- 若产生新约定（隔离库命名、runner 分工）写入 `.trellis/spec/`
- 用户验收后才提交；提交按仓库规范 `chore(task):` 归档节奏走

## Out of Scope (explicit)

- 不重新打开 `10-06-place-identity-governance` 的实体治理范围（各城实体归一批次）
- 不动 `10-09-attraction-top30-governance` 的排名与批次结论
- 不做 `independentPhotoIdentity` 之外的独立库测试迁移

## Technical Notes

- 相关文件：`apps/server/src/generation/tools/researchTools.ts`、`apps/server/src/generation/placeLookup.ts`、`apps/server/src/__tests__/placeLookup.test.ts`、`apps/server/src/__tests__/placeFacts.test.ts`、`scripts/verify-sql-first.mts`、`scripts/verify-place-identity.mts`
- 归档任务参考：`.trellis/tasks/archive/2026-10/10-06-place-identity-governance/`（prd.md 91KB，含层2 坐标旁路设计）
- 仓库提交规范：`.trellis/spec/guides/commit-convention.md`
- 并发约束：工作区可能有其他会话 staged 内容，提交必须显式指定路径
