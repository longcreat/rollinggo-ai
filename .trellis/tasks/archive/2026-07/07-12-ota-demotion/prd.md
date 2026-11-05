# ST3 OTA 场景降级：出行方式表单 + 住宿锚点 + 预算区间化

> 父任务：`07-12-switch-geo-stack-to-amap-gcj02-with-transit-legs-and-itinerary-overview-merge`（Decision 3/4/5）。前置：ST1 geoPipeline（computeLegs baseMode 目前为常量 'transit'）、ST2 前端 LegChip/tripDerive 已就绪。

## Goal

按父任务决策把 OTA 强相关场景降级为「服务于路线可行的后勤」：出行方式成为生成输入、住宿成为通勤锚点（非推荐）、预算从精确求和降为粗略区间。跨 shared/server/web 三层。

## Requirements

### R1 出行方式基调（Decision 3）

- shared：`TRANSPORT_MODES = ['transit','drive','walk']`；`GenerateFormSchema` + `TripSchema` 增 `transportMode`（可选，缺省 'transit'；Trip 持久化供未来重排复用）。
- server：`geoPipeline.computeLegs` 的 baseMode 改用 form.transportMode（距离启发不变：<1.5km 恒 walk）。
- web：PlannerPage 表单新增三选一（公共交通/自驾/步行优先，默认公共交通），样式沿用既有表单控件。

### R2 住宿锚点（Decision 4）

- shared：`LodgingSchema = { name: string(≤60), area?: string(≤40), lat?, lng?, coordSystem? }`；`TripSchema.lodging?`（Trip 级默认）+ `TripDaySchema.lodging?`（day 级覆盖，多城市场景）。
- **leg 哨兵约定**：TransitLeg 的 from/to 允许哨兵值 `'lodging'`（leg 挂在 day 上，作用域天然限定当天）：`{from:'lodging', to:<首活动id>}` 与 `{from:<末活动id>, to:'lodging'}`。schema 无需改（本就是 string），但须在 schema 注释与 spec 中写明契约；ST2 的 `legForPair` 按 id 严格匹配不受影响，DaySection 新增住宿 leg 的首尾渲染（「🏨 从住宿出发」/「返回住宿」）。
- 生成：GenerateForm 增 `lodging?: string(≤60)`（「住宿位置（可选，酒店名或大致区域）」）；用户留空时 planner prompt 指示 Agent 建议一个**区域**（如「西湖景区周边」，明令禁止推荐具体酒店/价格）写入 draft；geoPipeline 后处理对 lodging 做地理编码（同活动解析链），成功才生成住宿 leg。
- 编辑器：TripMetaDialog 可查看/修改住宿名称与 day 级覆盖；**修改名称即清空该锚点坐标并丢弃相关住宿 leg**（无客户端重编码端点，属后续任务）；无住宿锚点的天在 DaySection 顶部渲染一次性弱提示「未设住宿，通勤自首个活动算起」。
- 明确不做：酒店推荐列表、比价、预订链接。

### R3 预算区间化（Decision 5）

- shared：`ActivitySchema.cost` 改为 `Type.Optional(...)`（旧数据带值照读；读取方 `?? 0` 兜底）；`BudgetSummary` 派生类型改区间 `{ perPersonPerDayMin, perPersonPerDayMax, coveredDays }`，删除 `overBudget`。
- 推导口径（纯函数，放 web `lib/` 或 shared）：日成本 = 当天各活动 cost（缺省跳过）求和 ÷ partySize；区间 = [0.8×, 1.3×] 十位取整；展示「人均约 ¥X–Y/天（门票餐饮等，不含大交通与住宿）」+ 免责「AI 估算，出行前请核实」。
- web：BudgetPanel 改区间条展示，删除逐项精确总额与超支判定 UI；TripListItem.totalCost 列保留（服务端冗余列不动，列表页展示可加「约」前缀）。
- server：`reviewTools` 预算聚合与 prompts 同步——审校不再要求精确总价合规，改为检查「档位与 budgetLevel 明显失配」；planner prompt 要求 cost 为粗估档位值（免费=0，不确定留空）。

## Acceptance Criteria

- [ ] 表单可选出行方式与住宿位置；生成行程 legs 的 mode 遵循基调（>1.5km 段=所选 mode）
- [ ] lodging 解析成功时：Trip/day 持久化 lodging（含 gcj02 坐标）、当天首尾出现住宿 leg（哨兵 id）、DaySection/地图正确渲染；解析失败/未设：无住宿 leg + 弱提示，不报错
- [ ] Agent 建议的是区域而非具体酒店（prompt 断言 + 人工抽查一次生成输出）
- [ ] BudgetPanel 显示人均区间 + 免责；无任何精确总额/超支 UI 残留
- [ ] 旧行程（无 transportMode/lodging、cost 全有值）打开与导入导出完全正常
- [ ] 三包 typecheck/build 绿；ST1 单测不回归；verify-c2/c3 相关断言更新后通过

## Definition of Done

- 新增纯函数（预算区间、住宿 leg 匹配）有单测或纳入 verify 脚本断言
- TECHNICAL_ARCHITECTURE.md 数据模型章节同步（lodging/transportMode/cost 可选化/哨兵契约）
- spec 沉淀：TransitLeg 哨兵 id 契约写入 generation-guidelines

## Out of Scope

- 客户端重新地理编码端点、住宿变更后 leg 重算（→ 修订 agent 任务）
- 酒店推荐/比价/预订
- 可行性引擎

## Technical Notes

- ST1 契约：`geoPipeline.createGeoSession/geocodeAll/computeLegs`、解析链与配额闸门直接复用；lodging 编码计入 GEOCODE_MAX_PER_TASK
- ST2 契约：`tripDerive.legForPair` 严格 id 匹配；哨兵 leg 需新的匹配辅助（`lodgingLegsForDay(day)`）
- cost 必填→可选是唯一非纯增量变更：全仓 grep cost 消费点逐一 `?? 0` 兜底（BudgetPanel/PrintView/ExportMenu/reviewTools/draft.validate/tripService 冗余列计算）
