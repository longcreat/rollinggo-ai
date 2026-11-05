# 工具文案映射表改用稳定工具名 + 穷尽性校验

## Goal

生成进度里「正在…」的文案映射，现在用**服务端传的中文 label 当 key**。中文文案一改映射就静默失效，fallback 还会把内部术语泄露给用户——**这个问题已经发生了一次**。

改成用事件里已有的稳定工具名（`tool` 字段）做 key，并用 TypeScript 的 `satisfies` 保证穷尽，新增工具忘了配文案时编译期就报错。

## 现状证据

| 事实 | 位置 |
|---|---|
| 事件同时带稳定工具名和中文标签 | `packages/shared/src/types.ts:192-193`：`{ type: 'tool_start'; toolCallId; tool: string; label: string; args: string }` |
| 服务端确实传了两个字段 | `apps/server/src/generation/orchestrator.ts:145`、`:191` |
| Agent 工具定义成对给出 name + label | `apps/server/src/generation/tools/researchTools.ts:194-195` 等 |
| 系统任务也有稳定 id | `orchestrator.ts:433`：`runSystemTask('review', 'geo_geocode_review_changes', '解析改动地点坐标', ...)` |
| **构建时间线时把 `tool` 丢掉了** | `apps/web/src/lib/generationTimeline.ts:3-12` 的 `ToolItem` 只有 `label` |
| 前端用 label 当 key | `apps/web/src/components/GenerationRunPanel.tsx:139` `TOOL_COPY: Record<string, string>` |
| 取值方式 | `GenerationRunPanel.tsx:135`：`TOOL_COPY[item.label] ?? item.label` |

### 已经失效的一条（真实 bug）

```
服务端 researchTools.ts:499  label: '提交调研结果'
前端   TOOL_COPY            '提交调研摘要': '整理旅行灵感'
```

两者对不上 → 查表 `undefined` → fallback 到 `item.label` → **用户看到「正在提交调研结果…」，内部术语直接暴露**。

这正是本任务要根治的问题类型：任何人改一次服务端 label，都会静默退化成泄露内部术语。

## 完整工具清单（22 个稳定 id）

### Agent 工具（19）

| tool name | 服务端 label | 前端现 key 是否对得上 |
|---|---|---|
| `search_verified_places` | 查已验证地点库 | ✅ |
| `search_pois` | 搜索地点 | ✅ |
| `search_web` | 搜索攻略 | ✅ |
| `add_candidate` | 写入候选池 | ✅ |
| `submit_research` | 提交调研结果 | ❌ 前端是「提交调研摘要」 |
| `create_draft` | 建立行程骨架 | ✅ |
| `add_activity` | 添加活动 | ✅ |
| `update_activity` | 修改活动 | ✅ |
| `remove_activity` | 删除活动 | ✅ |
| `read_draft` | 查看草稿 | ✅ |
| `move_activity` | 调整活动日期 | ✅ |
| `suggest_lodging` | 建议住宿区域 | ✅ |
| `check_feasibility` | 可行性自查 | ✅ |
| `rewrite_activity_note` | 改写活动说明 | ✅ |
| `write_trip_title` | 撰写行程标题 | ✅ |
| `submit_draft` | 提交行程草稿 | ✅ |
| `submit_copy` | 提交文案 | ✅ |
| `geocode_place` | 查询地点坐标 | ✅ |
| — | （住店/路线相关工具由 geoTools 提供） | — |

> 上表 tool name 一栏除 `submit_research` 外需在实施时逐个核对 `apps/server/src/generation/tools/*.ts`，不要照抄本表。

### 系统任务（3）

| tool name | label |
|---|---|
| `geo_geocode_review_changes` | 解析改动地点坐标 |
| `geo_recompute_final_legs` | 复核最终通勤路线 |
| `optimize_cross_day_grouping` | 优化跨天路线 |

## Requirements

### R1 `ToolItem` 保留工具名

`apps/web/src/lib/generationTimeline.ts`：

- `ToolItem` 加 `tool: string` 字段
- `tool_start` 分支里 `tool: ev.tool`
- `tool_end` 配对时不变（已按 `toolCallId` 配对）

### R2 `TOOL_COPY` 键改成工具名 + 穷尽校验

`apps/web/src/components/GenerationRunPanel.tsx`：

```ts
type ToolName =
  | 'search_verified_places' | 'search_pois' | ...      // 与 shared 的 tool 定义同源
  | 'geo_geocode_review_changes' | ...;                  // 系统任务

const TOOL_COPY = {
  search_verified_places: '查找可靠的地点信息',
  search_pois: '寻找适合你的好去处',
  ...
} satisfies Record<ToolName, string>;
```

- key 全部换成工具名
- 用 `satisfies` 而非 `Record<string, string>`：漏配一个工具，`tsc` 报错

### R3 fallback 改成通用人话

```ts
TOOL_COPY[item.tool] ?? FALLBACK
```

`FALLBACK` 是固定通用文案（例如 `继续梳理行程细节`），**永远不显示 `item.label`**。

理由：`label` 是内部操作名，缺失映射时宁可说一句泛化的话，也不能把「查已验证地点库」这类词暴露给用户。

### R4 单测断言穷尽

新增一个测试（放 `apps/web/src/lib/__tests__/` 或现有 web 测试目录）：

- 遍历 `ToolName` 的每个 key，断言 `TOOL_COPY[k]` 是非空字符串
- 断言 `FALLBACK` 不等于任何 `label`

`satisfies` 已经在编译期覆盖了「少一个」，这个测试补的是「值为空串」这类运行期问题。

## 明确不做

| 不做 | 原因 |
|---|---|
| 参数模板（「正在查找上海的好去处」） | 会让前端耦合工具入参结构（`args` 是字符串化的 JSON）。城市信息在候选卡片上已可见，收益不值这个耦合 |
| 搬到 `packages/shared` | 有价值的后续项，但本任务只做「key 换对 + 穷尽校验」，避免一次动两个包 |
| `done` 态文案（「已找到 12 个去处」） | 需要 `tool_end.summary` 结构化，现在 `summary` 是自由文本。另开任务 |

## 改动清单

| 文件 | 改什么 | 规模 |
|---|---|---|
| `apps/web/src/lib/generationTimeline.ts` | `ToolItem` 加 `tool`，`tool_start` 分支赋值 | +2 行 |
| `apps/web/src/components/GenerationRunPanel.tsx` | `TOOL_COPY` 21 个 key 换名 + `satisfies` + `ToolName` 类型 + `FALLBACK` + 取值改 `item.tool` | ~30 行 |
| 新测试文件 | 穷尽性断言 | +1 文件 |
| `apps/server/src/generation/tools/*.ts` | **不动** | 0 |

### `ToolName` 类型的来源

优先从 `packages/shared` 导出（如果工具名已在 shared 定义过）；否则在 web 侧手写联合类型，并在注释里标注「与 server 工具定义同步」。手写类型仍然比 `Record<string, string>` 强得多——漏配会报错。

## 风险

1. **`tool` 字段是否全路径都有值**。`orchestrator.ts:191` 那条 `tool_start` 传了 `args: '{}'`，需确认它的 `tool` 也是稳定 id 而不是临时字符串。
2. **同 label 不同 tool**。如果两个工具共用一个 label，现在会映射到同一文案；换 key 后要分别配文案——这正是修复意图，但需要逐个确认文案是否合理。
3. 低风险改动，纯前端，不触碰生成主链路。

## 实施核对结果（10-22 落地时对源码逐项核对）

PRD 上面的工具表是凭记忆列的，实际 `apps/server/src/generation/tools/*.ts` + `orchestrator.ts` 的 `runSystemTask` 共 **28 个稳定 tool 名**（PRD 表中的 `submit_draft` / `submit_copy` / `set_lodging` 等命名与实际不符）：

- 调研 Agent（5）：`search_verified_places` `search_pois` `search_web` `add_candidate` `submit_research`
- 草稿工具（11，定义在 `draftTools.ts`，目前只有 `update_titles` 在生产路径被注册给 writer）：`set_trip_skeleton` `add_activity` `update_activity` `remove_activity` `get_draft` `move_activity` `set_lodging` `check_feasibility` `update_description` `update_titles` `submit_plan`
- 其他 Agent 工具（3）：`geocode_place` `submit_review` `submit_trip_advice`
- 系统任务（12）：`prefetch_verified_places` `geo_geocode_all` `optimize_day_routes` `geo_compute_legs` `simulate_feasibility` `schedule_itinerary` `repair_long_haul` `geo_geocode_review_changes` `geo_recompute_final_legs` `optimize_cross_day_grouping` `route_recompute_ordered_days` `prepare_trip_advice`

映射表放在 `apps/web/src/lib/generationToolCopy.ts`（而不是组件文件内）：`TOOL_NAMES` 是运行时清单与类型来源，`TOOL_COPY` 用 `satisfies Record<ToolName, string>` 兜住漏配；纯数据模块才能被 `apps/web/tests/` 的 Node 测试直接 import（web `src` 按浏览器类型编译，Node 测试按规范放 `apps/web/tests/`）。

## Acceptance Criteria

- [x] `ToolItem` 带 `tool` 字段，`tool_start` 事件能正确落进去
- [x] 触发生成时，进度文案全部来自 `TOOL_COPY`，不再出现「提交调研结果」这类内部 label
- [x] 故意删掉 `TOOL_COPY` 里任意一条，`tsc --noEmit` 报错
- [x] 缺失映射时显示 `FALLBACK` 通用文案，而不是 `item.label`
- [x] `submit_research` 这一条文案恢复正常（这是当前线上真实缺陷）
- [x] 单测通过
- [x] 真实跑一次生成，比对进度文案与阶段是否相符

### 验证记录（10-22）

| 验证 | 命令 | 结果 |
|---|---|---|
| 类型 | `npm run typecheck` | exit 0 |
| 构建 | `npm run build -w apps/web` | ✓ built |
| 单测 | `node --import tsx --test apps/web/tests/generationToolCopy.test.ts apps/web/tests/generationCards.test.ts apps/server/src/__tests__/generationTimeline.test.ts` | 17/17 |
| 穷尽性反证 | 临时删掉 `search_web` 一条后 `npx tsc --noEmit -p apps/web` | TS1360 + TS7053 报错，恢复后 exit 0 |
| 真实生成 | `VERIFY_GENERATION_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres node scripts/verify-generation-browser.mjs` | 5 项 PASS，采样到「正在整理旅行灵感…」「正在确认各个景点的位置…」「正在为旅程起个名字…」「正在准备出行提示…」 |
