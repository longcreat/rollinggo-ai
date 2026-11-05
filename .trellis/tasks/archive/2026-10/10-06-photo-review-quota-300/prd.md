# 放开景点视觉审核额度至 300 并清理测试残留

## 1. 问题

滚动 24h 额度（`DEFAULT_PHOTO_REVIEW_DAILY_PLACES = 50`）与稳态新增地点数恰好相等，
导致积压在数学上永远清不掉：

- `review-jobs` 149 个 queued 全是从未启动的 `priority=trip`（广州 35 / 上海 34 / 厦门 29 /
  成都 25 / 北京 22 / 济南 4），额度已 50/50 选满，只有 `attempts > 0` 的重试能通过闸门。
- 稳态新增约 50 地点/天（10-01~10-03 为 6–10，10-04 起 49+），剔除 10-05 的 186 异常值后
  仍约 50/天。**额度 = 新增 = 积压零消化**。
- 额度消耗是爆发式的：10-06 12:49 重启后几分钟内用掉 13 个额度并撞满，随后 worker 空转。
- 另有 5 个 `attempts=3` 的测试残留任务（`北京地点1/2/3/5`、`测试公园8`），
  `tick()` 与 `retryNow()` 都要求 `attempts < 3`，它们永远无法被调度也无法手动恢复。

依据与实测数据见 `research/photo-quota-baseline.md`。

## 2. 决策：额度设为 300

50 不是技术上限，是成本闸。串行 worker 的真实天花板是 **~1540 地点/天**
（121 个 done 样本平均 56.0s/地点，86400/56），而 VLM 端点承受的峰值并发恒为 1，
所以端点的 RPM 从来不是约束——只有总请求量（钱）是。每地点实测 10.8 次 VLM 请求。

| 档 | 地点/天 | VLM 请求/天 | worker 满载 |
| --- | --- | --- | --- |
| 50（现状） | 50 | ~540 | 47 min |
| **300（选定）** | **300** | **~3240** | **4.7 h** |
| 1500（串行天花板） | 1500 | ~16200 | 23.3 h，无余量 |

选 300 的理由：6 倍于稳态新增（留消化积压的空间）；worker 满载 4.7h，留 19h 空闲吸收突发；
149 积压半天清完。不选 1500 是因为串行 worker 会长期满载，新入队任务延迟明显。

## 3. 改动范围

1. `apps/server/src/integrations/photoReviewPolicy.ts:2` — `DEFAULT_PHOTO_REVIEW_DAILY_PLACES`
   由 `50` 改为 `300`。这是 `Math.min` 的**唯一硬上限来源**，必须改这一处。
2. `apps/server/.env:168` — `PHOTO_REVIEW_DAILY_PLACES=300`。**必须同步**：
   `env.ts:123` 是 `Math.min(int(env, DEFAULT), DEFAULT)`，env 留 50 会把生效值钳回 50，
   改动完全不生效。该文件被 edit 工具的 `*.env` 策略拦截，需人工执行，见第 7 节。
3. `apps/server/.env.example:184-186` — 「默认50，上限50」的注释措辞已失效，需同步为新上限。
4. `.trellis/spec/server/backend/preference-photo-pipeline.md` Contracts 段 —
   「默认滚动24h最多50个地点（显式配置可降低，上限50）」需同步。
5. `apps/server/src/__tests__/photoReviewQueue.test.ts:9-22` — 该用例依赖默认值：不注入
   `dailyLimit`、循环 51 次、`assert.equal(calls, 50)`。额度改成 300 后必须改，否则只启动 51 个
   就断言失败。**改法：显式注入 `dailyLimit: 50`**，保留 51 次循环与两条断言，让边界测试不再耦合
   默认值的具体数值；测试名由「允许50个地点」改为「额度上限个地点」。文件内其余用例均已注入
   `dailyLimit: 1`，不受影响。
6. 删除 `data/photo-store/review-jobs/` 下 5 个测试残留：`北京地点1`、`北京地点2`、
   `北京地点3`、`北京地点5`、`测试公园8`。

## 4. 明确不改（防止顺手扩大范围）

- 串行 worker 结构与 `createSerialQueue(0)` 不变。
- `countedAt` 记账语义不变：只计首次启动，重试不占额度也不推迟窗口（2026-10-05 济南事故的修复）。
- 饱和 warn（含 used/limit 与排队新地点数、容量恢复后复位）不变。
- 图源预算 `stockPhotoBudget`（Unsplash 45/h、Pixabay 90/min）与 `review-search` 24h 缓存不变。
- **保留 `Math.min` 的钳制结构**：env 仍不能超过常量，避免误配把 VLM 成本打爆。
  抬高上限只能通过改常量，这是有意的单一改动点。
- 6 个可自愈的 failed 任务（上海 5 个、济南 1 个）不动，交给正常重试。

## 5. 验收标准

- `photoReviewPolicy.ts` 常量为 300，`apps/server/.env` 与 `.env.example` 同步为 300。
- 重启服务后 `[photo-review]` 不再输出饱和 warn；`review-jobs` 中新任务能被调度
  （`attempts 0→1`、`countedAt` 写入）。
- `data/photo-store/review-jobs/` 不再有 `attempts=3` 的死任务。
- `npm run typecheck` 通过；`photoReviewQueue.test.ts` 全绿，包括改成注入 `dailyLimit: 50` 的
  「额度上限个地点，第上限+1 个等待窗口释放」用例，以及额度饥饿回归用例。

## 6. 风险

- **VLM 成本上升 6 倍**（~540 → ~3240 请求/天）。这是本次决策的核心代价，已在档位表中量化。
- **集中放量会撞 Unsplash 45/h**：撞了是软降级（该源搜索失败被 `catch` 吞掉，候选从 ~13 降到
  ~10 张），不报错。生产端由 15s tick 自然摊开，不集中爆发。
- 300 仍受 `Math.min` 钳制，env 误配只会降低不会升高，不存在"调错打爆成本"的路径。

## 7. 需人工执行的部署动作

`.env` 被 `*.env` 权限策略拦截，以下两条需人工执行，然后重启服务。

```powershell
cd D:\Project\tripweaver

# 1. 抬高生效额度（不改则 Math.min 钳回 50，本次改动不生效）
$p = (Resolve-Path 'apps\server\.env').Path
$t = [IO.File]::ReadAllText($p)
$t = $t -replace '默认50，上限50', '默认300，上限300'
$t = $t -replace 'PHOTO_REVIEW_DAILY_PLACES=50', 'PHOTO_REVIEW_DAILY_PLACES=300'
[IO.File]::WriteAllText($p, $t)

# 2. 删除 5 个 attempts=3 的测试残留（按 city+name+attempts 三重匹配，不会误删）
$d = 'data\photo-store\review-jobs'
$dead = @('北京地点1', '北京地点2', '北京地点3', '北京地点5', '测试公园8')
Get-ChildItem $d -Filter *.json | ForEach-Object {
  $j = Get-Content $_.FullName -Raw | ConvertFrom-Json
  if ($j.city -eq '北京' -and $dead -contains $j.name -and $j.attempts -eq 3) {
    Remove-Item $_.FullName -Force
    "removed: $($j.name)"
  }
}
```

重启后验收：`[photo-review]` 不再输出饱和 warn；`review-jobs` 中新任务 `attempts` 从 0 变 1
且写入 `countedAt`；目录中不再有 `attempts=3` 的死任务。
