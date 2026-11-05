# 当前实现核对（2026-10-02）

本文保留实施前的设计依据，后续实现与验证请看 [实施记录](implementation.md)。

## 已读取代码与结论

- `apps/web/src/components/chat/ChatPanel.tsx`：唯一对话入口；useSendMessage 一次性返回，等待状态“正在理解”；currentTripId 仅用于完成后导航；滚动依赖消息数量/等待态，需适配增量与用户阅读位置。
- `MessageBubble.tsx`：纯文本气泡，0.9rem，暂无 Markdown、独立摘要、结果卡。
- `ChatInput.tsx`：发送期间禁用输入，无停止；已有 IME/Shift+Enter 处理应保留。
- `apps/web/src/pages/TripEditorPage.tsx`：向 ChatPanel 传 conversationId/currentTripId；需要扩展当前日期和编辑保存状态，实施时进一步读取 store/save hooks。
- `packages/shared/src/chat.ts`：SendMessage 仅 text；消息支持 intake/relatedTripId，无建议/候选/摘要/流状态。
- `apps/server/src/routes/conversations.ts`：取 latestTrip 作为修改目标；理解后应用 editOps，createTrip 落版本，最后成对写消息；支持 autoStartedJobId。必须防范查询误触发生成，以及写版本后断连的重试一致性。
- `apps/server/src/chat/understanding.ts`：仅 propose_decision 工具；reply 在结构化决策里；没有实际查询美食能力。
- `apps/server/src/generation/agents/runner.ts`：thinkingLevel=off；onThought 从 message_end 的 text 块提取并截断，并非流式 reasoning；现有接口不能直接用于实时回答。
- `apps/server/src/generation/tools/researchTools.ts`：有 food 类目、verified places/POI/web 检索；生成阶段有 foodSearch 开关，用户明确要求美食查询不能被原始偏好未选美食挡住。可复用适配器，不宜直接照搬整个生成流程。

## 方案比较

- POST + fetch SSE：携带当前上下文和鉴权自然，适合本轮发送消息；需要解析增量、终态、取消和幂等恢复。推荐。
- POST 创建轮次 + GET SSE：方便后台轮次回放，但增加任务存储与生命周期；长任务可后续升级，本期不额外复制一套生成系统。
- WebSocket：双向能力充足，但本需求不需要持续双向通道，不采用。
- 添加 A：推荐位置在主按钮上完整显示，一键加入，另给调整入口；符合已有直接修订方向。添加 B：每次选位置，步骤更多但可控。留作用户偏好核对。

## UI 依据与限制

读取 ui-ux-pro-max 技能，采用阅读对比度、44px 操作区域、响应式、可访问折叠、稳定异步布局等适用原则；技能脚本 search.py 在给定位置缺失，搜索现有技能目录未找到，因此没有生成设计系统报告。沿用项目视觉 token，未引入其偏移动原生的组件规范。

本轮为静态代码与文档核对，没有运行应用、真实美食查询或功能测试。来源覆盖、具体日程保存机制、局部重排接口需实施阶段验证，不当作已完成能力。

## 历史版本补充核对

- `TripEditorPage.tsx` 右上角 `editor-toolbar-right` 仅渲染 ExportMenu；无历史入口，用户反馈与代码一致。
- `apps/web/src/api/hooks.ts` 已有 useTripVersions；服务端 `GET /api/trips/:id/versions` 返回同用户同 rootId 的版本列表（升序）。
- `tripService.ts` 的 listTripVersions 当前返回 id/version/title/createdAt，无修改来源或恢复来源，UI 不能虚构来源标签。
- `revisionLineage` 当前按目标 version + 1 创建子版本；恢复 v2 为新最新版不能直接对 v2 使用该函数，否则与已有 v3 冲突。应复制历史内容、以当前最新版本为父版本，原子校验和分配下一版本。
- `updateTrip` 目前原地覆盖内容，尚无旧版本只读或并发标识约束；因此现有历史并不包含每次手动编辑的快照。新设计必须限制旧版本写入并处理自动保存竞争。
- trips 路由无恢复接口。恢复需新增服务端能力，并更新会话当前行程锚点；单加历史 UI 不足以完成需求。
- createTrip 按用户所有 trips 行计数，上限会包含版本，达到限制须明确失败；本期不自动清理历史。
