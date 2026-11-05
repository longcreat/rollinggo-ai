# 修复后复跑验证（2026-09-20）

对照基线：`09-20-gen-timing/research/2026-09-20-phase-timing.md` 的 run2（job `18af87a0`）。
本次 run3 job `15459b01`，原始日志 `.trellis/tasks/09-20-gen-timing/research/timing-run-3-after-fixes.log`。

命令（`AMAP_DAILY_BUDGET` 用进程环境注入，因为 `.env` 受编辑策略保护、改不了）：

```powershell
cd apps/server
$env:AMAP_DAILY_BUDGET = '600'
npx tsx test-gen-timing.mts
```

## 一、结论速览

| 指标 | 修前 run2 | 修后 run3 | 判定 |
| --- | --- | --- | --- |
| `geo_geocode_all` | 165.7s | **3.2s** | ✅ 修复 1 生效 |
| `geo_compute_legs` | 0.0s | 8.7s | 高德可用后开始真实算路 |
| research 阶段 | 149.3s | 137.3s | 略降 |
| **plan 第 1 轮** | **597.8s** | **314.8s** | ✅ 降 47% |
| plan 第 1 轮 LLM 轮次 | 14 | **6** | ✅ soft 空转消失 |
| `check_feasibility` 调用次数 | 6 | 2 | ✅ 修复 3 生效 |
| 第 1 轮合计（research+plan+review） | 782.7s | **503.2s** | ✅ 降 36% |
| 总墙钟 | 793.4s | 901.5s | ❌ **本轮 cancelled** |
| 高德调用 | 8（仅搜索） | **38** | ✅ 额度闸门已开 |

**第 1 轮管线修好了（503.2s vs 782.7s），但本轮审校要求修订，第 2 轮（修订轮）单独烧了约 370s，直接撞上 15 分钟超时。**

## 二、修复 1（Nominatim 快速失败 + 熔断）—— 生效

```
nominatim「北京 天安门广场」   10012ms → 2505ms
[nominatim] 连续失败 3 次（超时/网络错/HTTP 非 2xx），本进程熔断 60s
nominatim「景山公园」                     0ms
geocodeActivity(null, 慕田峪长城)         0ms   （修前 22315ms）
3 个地点串行合计   66.8s → 0.0s
```

`geo_geocode_all` 166s → 3.2s，且本轮高德可用（`amap=38`），17 个活动坐标全部解析成功。

## 三、修复 2（AMAP_DAILY_BUDGET）—— 闸门验证通过，`.env` 待用户手动改

用环境变量注入 `600` 后：`今日剩余=468`，闸门判定「高德可用」，本轮 `amap=38` 次真实调用。
**`.env` 仍是 150**（编辑被 `*.env` 策略拒绝），需用户执行一行命令才能永久生效。

## 四、修复 3（soft 违规收敛）—— 生效

plan 第 1 轮从 14 轮降到 6 轮，`check_feasibility` 只调了 2 次，模型不再为一个"缓冲 9%"的 soft 提示反复微调：

```
[t+438.7s] 三天活动已全部填充。让我检查一下当前草稿和可行性。
[t+443.7s] 可行性检查通过，无硬性问题。…现在提交校验。
```

## 五、修复 4（reasoning effort = medium）—— 机制生效，**但没有省时间**

请求体确实带上了参数（`test-reasoning-effort.mts` A/B）：

```
reasoning=undefined → 请求体 reasoning_effort=(未出现在请求体)  thinking 74 字符
reasoning=medium    → 请求体 reasoning_effort=medium           thinking 100 字符
```

但真实生成里看不出收益：

| 指标 | run2（off） | run3（medium） |
| --- | --- | --- |
| plan 第 1 轮输出 token | 47228 | **51646（更高）** |
| plan turn1 输出 token | 23984 | 26744 |
| plan turn1 thinking 字符 | 60275 | 40683 |
| plan turn2 thinking 字符 | 30105 | **77576** |

推理量没有系统性下降，输出 token 反而更高。**`reasoning_effort` 对这条网关 + 这个模型不是有效的省时杠杆。** 小请求 A/B 只有 74→100 字符的差别，说明网关基本吃掉了这个参数。

## 六、本轮新暴露的瓶颈：修订轮（第 2 轮 plan）

审校判定「需修订：3 项」后进入第 2 轮，该轮消耗：

```
plan 第2轮 turn1  85.2s  in=  8158 out= 14184
plan 第2轮 turn2 171.6s  in=  2291 out= 28857
plan 第2轮 turn3 111.1s  in=   175 out= 18056
plan 第2轮 turn4   4.5s  in=  1524 out=   146
plan 第2轮 turn5    --   aborted ⚠ Request was aborted
```

4 轮输出 61243 token、约 370s，单轮最长 171.6s（28857 token）。**修订轮时长与第 1 轮同量级，第 1 轮省下来的时间还不够它花。**

直接后果：任务在 901.5s 被 15 分钟超时取消，用户拿不到行程——比"慢"更糟。

### 附带疑问（未解）

修订轮的两个大 turn（28857 / 18056 输出 token）都发生在"压缩第 2 天时长、把晚餐挪到末尾"这类**结构性重排**上，而 `PLANNER_REVISION_SYSTEM_PROMPT` 明确要求"禁止清空草稿、重建骨架"。逐轮输出量与第 1 轮全量规划相当，怀疑修订轮在重写而不是局部改。下次应查 `llm_request_logs` 里修订轮的工具调用序列与 args 体积来确认。

## 七、下一步建议（按收益排序）

| # | 动作 | 依据 |
| --- | --- | --- |
| 1 | 修订轮加轮次/输出预算上限（如 `maxTurns` 6 + 明确"只改审校点名的活动"），或把审校修订阈值收紧到只报 hard | 本轮 370s、撞超时的直接原因 |
| 2 | 审校阶段不要对 soft 项提修订要求 | 本轮 review 提出 3 项修订要求，触发了整个第 2 轮 |
| 3 | 回退或改试 `reasoning_effort: 'low'` / `'minimal'` | medium 实测无收益（见第五节） |
| 4 | 复跑一次确认第 1 轮 503.2s 可复现 | 单次样本，run1/run2 差异有 200s |
