# 生成管线分阶段耗时实测（2026-09-20）

真实 LLM 实测两次完整生成，拆到「阶段 → 工具/LLM → 单轮 token」三层。测量脚本：

- `apps/server/test-gen-timing.mts` — 阶段/工具/LLM 三层拆分（工具占用按**区间并集**计，并行调用不重复累加）
- `apps/server/test-llm-output-probe.mts` — 单轮 output token 里 thinking / toolCall / text 各占多少
- `apps/server/test-geo-latency.mts` — 地理解析链路每一级的真实延迟
- `apps/server/test-pg-latency.mts` — PG 往返延迟

运行方式：必须 `cd apps/server` 后 `npx tsx <脚本>`（`dotenv/config` 只读 cwd 下的 `.env`，仓库根目录没有 `.env`）。

## 一、两次实测总表

场景：北京 3 天、2 人、公共交通、历史文化。模型 `cline-pass/deepseek-v4-flash`。

| 运行 | 总墙钟 | research | plan | review | plan 输出 token | plan 轮次 |
| --- | --- | --- | --- | --- | --- | --- |
| run1 `7b69f2fb` | 585.1s | 133.0s（23%） | 399.4s（68%） | 44.4s（8%） | 30001 | 7 |
| run2 `18af87a0` | 793.4s | 149.3s（19%） | 597.8s（75%） | 35.6s（4%） | 47228 | 14 |

run2 的三层拆分：

| 阶段 | 墙钟 | 占比 | 工具占用 | LLM 等待 | LLM 轮次 | 输出 token |
| --- | --- | --- | --- | --- | --- | --- |
| research | 149.3s | 19% | 25.4s | 123.9s | 8 | 12628 |
| plan | 597.8s | 75% | 165.8s | 431.9s | 14 | 47228 |
| review | 35.6s | 4% | 0.1s | 35.6s | 3 | 2922 |

结论：**编排阶段占 75%，是唯一需要动的阶段**。其中 LLM 生成 432s、地理编码 166s。

## 二、瓶颈 A：plan 的 432s 几乎全是隐藏推理（thinking）

`plan` 阶段可见文本合计 **392 字符**，却消耗 **47228 输出 token**。拆开 assistant 消息的 content part：

| 轮次 | 输出 token | 耗时 | thinking 字符 | toolCall 字符 | text 字符 |
| --- | --- | --- | --- | --- | --- |
| turn1 | 23984 | 144.6s | **60275** | 329 | 64 |
| turn2 | 15934 | 182.4s | **30105** | 5116（14 个 add_activity） | 72 |

两轮 thinking 合计 90380 字符 ≈ 36k token，占 plan 输出的 76%。输出速度约 150~166 tok/s，所以**单轮耗时 ≈ thinking 长度 ÷ 输出速度**——不是内容需要，是推理开销。

对比：research 阶段同理（turn6 64.4s / 6944 token / 可见文本 39 字符）。

## 三、瓶颈 B：`geo_geocode_all` 165.7s —— 高德被额度闸门关掉，回落到不可达的 Nominatim

链路（`integrations/amap/geocoder.ts`）：高德 POI text → 高德 v3 geocode → Nominatim ×2 → null。

实测证据：

```
AMAP_DAILY_BUDGET=150 今日剩余=18
闸门需要剩余 >= 60（GEOCODE_MAX_PER_TASK 40 + ROUTE_MAX_PER_TASK 20）→ 高德被闸门关闭

nominatim「北京 天安门广场」  10012ms  null
nominatim「天安门广场」      11118ms  null
geocodeActivity(null, 慕田峪长城) 22315ms null
geocodeActivity(null, 南锣鼓巷)   22247ms null
geocodeActivity(null, 牛街)       22257ms null
```

- `geoPipeline.init()` 的闸门要求日额度剩余 ≥ 60，实际只剩 18 → 本任务 `apiKey = null`，整条链跳过高德。
- 兜底面 `integrations/geocode.ts` 是 Nominatim，本机**完全不可达**：每次请求 10s 超时返回 null，串行队列还有 1100ms 间隔。
- `geocodeActivity` 对每个地点调 **两次** Nominatim（`${city} ${name}` 和 `name`）→ 22.3s/地点，且全部返回 null。
- 14 个活动 + 住宿 + 城市中心，2 并发 ≈ 166s，正好对上实测的 165.7s。

进度日志印证：`(4/14) t+600s → (8/14) t+634s → (12/14) t+689s → (14/14) t+734s`，每 4 个约 33~56s。

## 四、瓶颈 C：一个 soft 提示让模型空转 9 轮、77.7s

`FEASIBILITY_THRESHOLDS.softBufferRatio = 0.1`，第 1 天缓冲 9% < 10% 触发的是 **soft（不阻断）** 违规，但模型连续微调：

```
t+508.7  检查结果只有一条可优化提示：第1天节奏近满（缓冲 9%）。我来微调
t+533.2  第1天缓冲不足的提示仍存在（可优化项）。我再压缩一下
t+555.1  这条提示可优化但不阻断。我再压缩一次
t+571.7  这条提示已接近达标（缓冲 9%，与 10% 临界）。我再做最后一轮微调
t+584.4  可行性检查已通过 …
```

代价：plan turn5~13 共 9 轮、77.7s，19 次 `update_activity` + 6 次 `check_feasibility`，每轮 thinking 2.4~3.1k 字符。

## 五、次要观察

- **远端 PG 往返 232~405ms**（`SELECT 1` avg 315ms / max 660ms）。research 阶段 `add_candidate` 22 次合计 62.7s（最慢 7.9s）、`search_verified_places` 12 次合计 33.3s——多个并行工具调用在远端 PG 上排队，不是单次查询慢。
- **知识库优先改动已在真实模型上生效**：run2 数据源 `amap+websearch` 均可用，但 `search_web` 调用 **0 次**，`search_verified_places` 12 次、`search_pois` 8 次，模型自述「全程未触发兜底搜索」，22 个候选全部来自知识库 + 高德事实补全。`test-beijing-rag.mts` 时代那种「先搜网页拿攻略」的行为没有出现。

## 六、建议（未实施，按收益排序）

| # | 动作 | 预计收益 | 说明 |
| --- | --- | --- | --- |
| 1 | Nominatim 快速失败：10s 超时降到 2~3s；或按 `routeBreaker` 思路加域名级熔断 | ~150s | 不可达时不该等 10s×2×地点；两处改动都在 `integrations/`，不碰生成逻辑 |
| 2 | 修高德额度：`AMAP_DAILY_BUDGET=150` 对单次 3 天行程（闸门需 ≥60）太紧，已被闸门关停 | 直接消掉瓶颈 B | 属配置/额度策略问题，不是代码 bug |
| 3 | soft 违规不必追：prompt 明确「soft 违规最多修 1 次，之后必须 submit_plan」 | ~70~90s | 或让 `check_feasibility` 对 soft 项直接回「可忽略，勿再修改」 |
| 4 | 降推理开销：换非推理模型或调低 reasoning effort | ~200s+ | 单轮 2.4 万 thinking token 与产出内容无关 |
| 5 | research 的 `add_candidate` 批量提交 | ~30s | 远端 PG 排队；改工具签名或走一次批量 RPC |

只做 1+2+3 的预计效果：793s → 约 450s，落回 15 分钟超时的 50% 以内。
