# PRD:旧逻辑清理(harness 化收尾)

## 范围
1. 直删(生产零引用,已核实):chat/understanding.ts、chat/prompts.ts、chat/editOps.ts、chat/placeIdentity.ts、generation/tools/geoTools.ts、tools/reviewTools.ts(ReviewOutcome 内联)、shared/followUpSuggestions.ts、detailKnowledge 死函数、draftTools 死工具(set_trip_skeleton 等 9 个,writer 只留 update_titles)、placeRetrieval near 占位、healthRepair reorder_day/shift_times 占位
2. 先真机验证 harness add_day 覆盖「再加N天」后删:chat/researchAddedDays.ts → scheduling/buildDraft.ts → schedule.ts buildSchedule 链(ScheduleDateConflictError/scheduleClosureConflicts 挪独立文件保留;longHaul.ts 只删 classifyLongHaulPois,保 MIN_LOCATED_POIS/medianCenter)
3. chat/models.ts → chat/parse.ts(仅 asRecord/readString/readStringArray,foodSearch/brief 改引用)
4. 测试同步:删除/更新对应 __tests__ 与 verify-sql-first 清单;eval:agent 工具清单不受影响

## 验收
typecheck ✅ · eval:test ✅ · verify-sql-first 全量 ✅ · 真机:接口 SSE(harness 加天落版本) + UI(对话步骤/改动清单/撤销/体检面板)交叉验证 ✅
