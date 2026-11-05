# 景点视觉审核额度：现场基线（2026-10-06）

采集时间：2026-10-06 12:55（本地 UTC+8）。数据来自 `data/photo-store/review-jobs/`（283 个任务文件）、
`data/photo-store/review-reports/`（134 个）、`data/photo-store/visual-reviews/`（1461 个）、
`apps/server/src/integrations/photoReviewQueue.ts` 与 `photoCollection.ts` 源码。

## 1. 队列现状

| state | 数量 |
| --- | --- |
| queued（`attempts=0`，从未启动） | 149 |
| done | 121 |
| failed | 11 |
| running | 2 |

- 149 个 queued 全部 `priority=trip`，按城市：广州 35 / 上海 34 / 厦门 29 / 成都 25 / 北京 22 / 济南 4。
- 滚动 24h 已计额度 **50/50**（`countedAt ?? lastStartedAt` 落在窗口内），闸门已选满。
- 唯一能通过的只有 `attempts > 0` 的重试；新地点一律排队。
- 服务进程存活：端口 8787 node pid 33920，StartTime 2026-10-06 12:49:05。两个 running 任务
  （上海 外白渡桥、上海 苏州河）租约仅 stale 1–2 分钟，未进入 15 分钟恢复窗口。

## 2. 额度消耗是爆发式的，不是平滑的

窗口内 `countedAt` 按小时（UTC）：

```
10-05 04Z   3
10-05 05Z  32
10-06 03Z   2
10-06 04Z  13
```

10-06 12:49 重启后在几分钟内用掉 13 个额度，随后撞满 50 并停摆。额度释放是逐条滑出窗口，
首批 35 个（10-05 04Z–05Z）在本地 12:52–14:00 释放，之后重新撞满。

## 3. 单地点真实耗时（串行 worker 的吞吐上界）

`photoReviewQueue` 的 worker 是**全局 1 并发**：`createSerialQueue(0)`（`serialQueue.ts`）
加上 `tick()` 自身的 `active` 守卫，`tick` 也由 15s `setInterval` 驱动。

121 个 `done` 且 `lastStartedAt > 0` 的样本，`updatedAt - lastStartedAt`：

| 指标 | 值 |
| --- | --- |
| min | 3.4 s |
| p25 | 10.7 s |
| 中位 | 30.0 s |
| p75 | 97.2 s |
| p90 | 128.2 s |
| max | 189.8 s |
| 平均 | 56.0 s |

推论：串行吞吐 = 86400 / 56 ≈ **1540 地点/天**（按中位数则约 2880）。耗时差异来自审核缓存命中
（`visual-reviews` 命中时不发 VLM 请求）。

**关键结论**：VLM 端点承受的峰值并发恒为 1。端点的 RPM 从来不是约束；被限制的只有总请求量（成本）。

## 4. 每地点实际 VLM 请求数

134 个 `review-reports`：

| 指标 | 值 |
| --- | --- |
| 每地点 `reviewed` 平均 | 10.8 |
| 中位 | 11 |
| max | 13 |
| 每地点 `failed` 平均 | 0.1（总计 18） |

候选上限是代码写死的 `result.slice(0, 18)`（`collectPhotoCandidates`），实测不会跑满——各源
按 3 张轮转后通常得 11–13 张。所以 **VLM 请求数 ≈ 地点数 × 10.8**。

## 5. 稳态新增 ≈ 50 地点/天

`review-jobs` 文件按 mtime 分组：

```
10-01  10
10-02   6
10-03   8
10-04  49
10-05 186
10-06  24   （截至 12:55）
```

10-05 的 186 是额度耗尽后批量刷新 `updatedAt` / 新增入队的异常值，不是稳态。剔除后稳态约
**50/天**。

**根因**：额度 50 = 新增 50。积压在数学上永远清不掉，只会长期停在 149 附近并随行程增长上浮。

## 6. 会先撞的软闸门：图源预算

每个冷启动地点对 4 个源各发 1 次搜索（`pexels` / `pixabay` / `unsplash` / `commons`，
`collectPhotoCandidates`）。`stockPhotoSupport.ts:52` `stockPhotoBudget`：

| 源 | 上限 | 换算 |
| --- | --- | --- |
| Unsplash | 45 次/小时 | 1080/天 |
| Pixabay | 90 次/分钟 | 129600/天 |

搜索响应缓存 24h（`data/photo-store/review-search/` 524 个文件），命中不消耗。

后果：把 300+ 地点集中在一小时内处理会撞 Unsplash 45/h。撞了**不报错**——该源搜索失败被
`catch` 吞掉，候选从 ~13 张降到约 10 张。是软降级，不是故障。放量时应避免集中在 1 小时内。

## 7. 额度档位换算

| 档 | 地点/天 | VLM 请求/天（×10.8） | worker 满载（×56s） |
| --- | --- | --- | --- |
| 50（现状） | 50 | ~540 | 47 min |
| 200 | 200 | ~2160 | 3.1 h |
| **300（选定）** | **300** | **~3240** | **4.7 h** |
| 500 | 500 | ~5400 | 7.8 h |
| 1500（串行天花板） | 1500 | ~16200 | 23.3 h，无余量 |

选 300 的依据：稳态新增约 50/天，300 留 6 倍余量；4.7h 满载留 19h 空闲吸收突发；149 积压半天清完。

## 8. 5 个永久死任务（测试残留）

`data/photo-store/review-jobs/` 中 `attempts=3` 且 `nextAt` 早已过期：

| city | name |
| --- | --- |
| 北京 | 北京地点1 |
| 北京 | 北京地点2 |
| 北京 | 北京地点3 |
| 北京 | 北京地点5 |
| 北京 | 测试公园8 |

`tick()` 的筛选条件是 `j.attempts < 3`，所以它们永远进不了可调度集合；`retryNow()` 同样要求
`attempts < 3`，也无法手动恢复。它们既不是真实地点也不影响额度计数（`countedAt` 已滑出窗口），
只污染 `jobs()` 全量读取与状态统计。是测试写入生产 `data/` 目录的残留。

另有 6 个可自愈的 failed：上海 思南公馆 / 静安寺 / 豫园 / 东方明珠 / 陆家嘴（`attempts=1`，
10–25 分钟后重试），济南 环联夜市（`attempts=1`，已到期）。

## 9. 改动点

1. `apps/server/src/integrations/photoReviewPolicy.ts:2` — `DEFAULT_PHOTO_REVIEW_DAILY_PLACES`
   是 `Math.min` 的**唯一硬上限来源**，必须改这里。
2. `apps/server/.env:168` — `PHOTO_REVIEW_DAILY_PLACES` 需同步抬高；若 env 仍为 50，
   `Math.min(50, 300)` 会钳回 50。
3. `apps/server/.env.example:184-186` 注释 — 「默认50，上限50」的措辞会失效。
4. `.trellis/spec/server/backend/preference-photo-pipeline.md` Contracts 段 —
   「默认滚动24h最多50个地点（显式配置可降低，上限50）」需同步。
5. 删除上表 5 个测试残留 job 文件。

不改：串行 worker、`countedAt` 记账语义、饱和 warn、图源预算、`Math.min` 的钳制结构本身
（保留 env 不能超过常量的语义，避免误配打爆成本）。
