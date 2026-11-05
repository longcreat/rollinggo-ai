# 调研记录：TripStar / Yuntu 竞品架构对比

- 日期：2026-09-17
- 调研人：aimer（由 Claude 主会话整理）
- 关联：`tripweaver-positioning-roadmap`（可信规划器 / 抗幻觉 / BYOK / 中立）
- 源码本地副本：`D:/Project/study/Yuntu`（TripStar 仅调研 README + 架构时序图）

---

## 1. 两项目定位速览

| 维度 | TripStar (1sdv/TripStar) | Yuntu (Trunks820/Yuntu) |
|---|---|---|
| 哲学 | LLM 驱动一切（小红书 UGC → LLM 提纯 → LLM 聚合） | 确定性核心 + 创造性外围 |
| 数据来源 | 小红书原生签名接口 / SSR 备用爬取 + 高德/Google POI | 自建 PostgreSQL 验证 POI 库（`travel_canonical_place`） |
| 技术栈 | Vue 3 + FastAPI + HelloAgents | React 18 + FastAPI + PG16 + Tailwind |
| 地图 | Google/高德双引擎自动回退；高德 JS API 2.0（JSCode 构建期注入） | 高德 Web 服务 + JS API |
| 任务模型 | 异步 task_id + WebSocket 进度推送 | 异步 job_id + SSE 流式 + 轮询 |
| 防幻觉 | UGC 上下文 + 事后 LLM 容错解析（五级兜底 `_parse_response`） | 架构级：地点绝不交给 LLM 生成 + Publish Gate 确定性复核 |
| 体验亮点 | 预约提醒、知识图谱可视化、伴游问答、偏好记忆库、POI 图片懒加载 | 同区聚类、通勤预算硬约束、住宿商圈重心推导、行前准备、费用估算引擎、PDF/海报导出 |

---

## 2. Yuntu：LLM 参与环节清单（核心收获）

角色注册表见 `src/agents/llm.py`（`_TRACE_TRUTH_ROLES`），共 **6 个 LLM 角色**：

| # | 角色 | 模块 | LLM 职责 | 确定性护栏 |
|---|---|---|---|---|
| 1 | intent | `intent_parser.py` | 自然语言 → TripRequest JSON | schema 校验 + 正则兜底 |
| 2 | grouping | `semantic_grouping.py` | 候选 POI 语义分组（LLM 提议） | 确定性 validator 验证 |
| 3 | selector | `poi_selection.py` | 在候选池内挑 POI | deterministic-guarded，只能选 SQL 召回的真实地点 |
| 4 | writer | `final_writer.py` / `speculative_writer.py` / `write_review_pipeline.py` | 基于已授权事实载荷渲染文案 | `evidence_strength.py` 先做证据分级，只能引用被授权事实 |
| 5 | review | `yuntu_review.py` | 复核编造/来源缺失/数据缺口 | 大量 `_is_safe_*` / `_is_review_overreach_record_only` 把 LLM 误报降级为仅记录 |
| 6 | fragment repair | `fragment_repair.py` / `keyed_fragment_repair.py` | 白名单片段定点修复（span-targeted，非整篇重写） | 严格白名单 |

边缘第 7 类：`FAILURE_MESSAGE_POLISH`——发布失败/城市澄清文案的措辞润色（标记 `OTHER_SAFE`）。

### LLM 明确不参与的层
- 地点召回（纯 SQL）
- 路线规划 / 同区聚类 / 通勤预算 / Route Feasibility（空间算法）
- 住宿商圈推导（重心算法）
- 行前准备（`pretrip_advice.py` 规则 + 事实载荷 + sanitizer 降级）
- 天气建议（确定性 payload）、到达时间文案（纯正则 `arrival_copy.py`）
- 发布门禁（`publish_gate.py` 确定性规则）
- 费用估算（`cost_estimate/` + `cost_reference/` 参考数据表）

### 关键机制
- **Speculative writer 赛跑**：同一写作任务 Opus 主写 + DeepSeek standby 并发，按设计 §8.4 真值表裁决（`cancel_by_opus_win` / `cancel_by_budget_cutoff`）。冗余换延迟/成本。
- **模型槽位分层**：每角色独立 provider/model/key（`RoleConfig`）；`POOLED_ROLES = (review, grouping, selector)` 支持 relay 池化端点故障转移。
- **Review 误报治理**：LLM 审核员无一票否决权，越权指控降级「仅记录」。

---

## 3. 对 TripWeaver 的启发（按 ROI 排序）

1. **Publish Gate 独立质量关卡**（Yuntu）——最高价值。在 geo 可信防线 + 金集评测之外，补一个输出前确定性复核层：价格声明检测、路线越界（单日通勤超预算）、品牌编造正则。可作为 M2 修订 agent 之前的轻量规则关卡。
2. **6 角色槽位模型**——BYOK 卖点。intent/grouping/selector/writer/review/repair 各自独立配 provider+model。我们的 generation orchestrator 可把「调研/起草/修订」拆为独立模型槽位。
3. **「LLM 提议、确定性验证」第三条路**（grouping/selector 模式）——介于纯算法与纯 LLM 之间，比二分法灵活。
4. **种子数据库策略**——金集 9 城已沉淀的验证 POI 可固化为 canonical_place 一等公民，避免每次重新调研。
5. **fragment repair 白名单制**——M2 修订 agent 的边界设计参考：不整篇重写，只修白名单片段。
6. **预约提醒**（TripStar）——低成本高感知：从攻略数据识别「需预约」景点醒目标注，可做修订 agent 检查项。
7. **POI 图片懒加载**（TripStar）——主流程不阻塞，生成后按 POI 名异步补图。M0 加图片照此模式。
8. **伴游问答上下文持有**（TripStar）——M2 之后预留数据结构。

### 明确不借鉴
- 小红书 cookie 爬取（违背 ADR 0001；F9 已实测破产）
- 知识图谱可视化（炫技，与可信核心价值弱相关，YAGNI）
- 多智能体角色扮演（天气专员/酒店专员等表演型架构）

---

## 4. 后续候选动作
- [ ] 起草 Trellis 任务：Publish Gate 确定性复核层（对齐 M1 评测 / M2 修订前哨）
- [ ] 起草 Trellis 任务：generation 模型槽位分层设计（BYOK）
- [ ] M2 修订 agent 设计时参考 fragment repair 白名单契约（`writer_repair_contract.py`）
