# 选图队列额度饥饿：现场证据

采集时间：2026-10-05 12:50–13:00（本地 UTC+8）。数据来自 `data/photo-store/review-jobs/`（271 个任务文件）+ PostgreSQL `trips` 表。

## 现象

行程 `dea5aa28-6bd1-468e-b818-9c3db62ee35e`（济南三日泉湖山水行，destination=济南）13 个景点全部 `coverUrl=null`、`photos=[]`。

对应 13 个审核任务全部 `state=queued`、`attempts=0`、`lastStartedAt=0` —— **一次都没被调度过**，文件 mtime 停在入队时刻 10-04 21:07。

## 关键代码路径

`apps/server/src/integrations/photoReviewQueue.ts` 的 `tick()`：

```ts
const all = await jobs();
const capacity = all.filter(j => j.lastStartedAt > now() - DAY).length
  < (options.dailyLimit ?? DEFAULT_PHOTO_REVIEW_DAILY_PLACES);
const next = all.filter(j =>
    j.attempts < 3 && j.nextAt <= now() &&
    (capacity || j.lastStartedAt > now() - DAY) &&          // ← 额度耗尽时的闸门
    (j.state === 'queued' || j.state === 'failed' || ...))
  .sort((a, b) => Number(b.priority === 'trip') - Number(a.priority === 'trip')
               || a.nextAt - b.nextAt)[0];
```

- `capacity` = 「滚动 24h 内已启动过的地点数 < 50」
- `capacity === false` 时，`lastStartedAt === 0` 的**全新任务被整体排除**；只有「已在窗口内启动过」的任务能继续被重试。
- `env.ts:123`：`dailyLimit = Math.min(env, DEFAULT_PHOTO_REVIEW_DAILY_PLACES)`，即 **50 是硬上限，只能调低不能调高**。

## 时间线（本地时间）

| 时间 | 事件 | 证据 |
|---|---|---|
| 10-03 23:00 – 10-04 02:00 | 跑了 50 个地点 | `lastStartedAt` 直方图 10-03T15Z…18Z 合计 50 |
| **10-04 21:07** | 济南 13 个任务入队 | 文件 mtime |
| 10-04 21:07 起 | **全部被额度闸门排除** | 此刻窗口内 `lastStartedAt` 计数 = 50（阈值 50） |
| 10-04 全天 | worker 零启动记录 | `lastStartedAt` 直方图 10-04T00Z…23Z 全为空 |
| 10-05 00:00 – 02:00 | 130 次任务文件写入，但**零次启动** | 该时段无任何 `lastStartedAt`；窗口内计数当时仅 28，额度其实是够的 |
| 10-05 11:53 | 服务重启，窗口内计数因 24h 滑出降到 5 | 8787 端口进程 StartTime |
| 10-05 12:38 | worker 恢复处理**全新任务** | `北京动物园 attempts: 0→1` |
| 10-05 12:52 | 济南排在第 **#8–20** 位 | 按 worker 排序规则复算 |

历史启动分布（`lastStartedAt` 按小时）：

```
10-01T14Z  3   10-02T14Z  1   10-03T15Z  5   10-05T03Z  5
10-01T15Z  7   10-02T15Z  5   10-03T16Z 17   10-05T04Z 29
              10-02T16Z  4   10-03T17Z 23
                             10-03T18Z  5
```

## 三个独立缺陷

### 1. 额度耗尽的 24h 窗口被重试「刷新」，饥饿期被拉长

`capacity === false` 时通过闸门的是「已在窗口内启动过」的任务。每次重试都会写 `lastStartedAt = now()`，把这些任务重新推回窗口内，窗口因此无法自然滑出。只有等这些任务把 `attempts` 耗到 3、彻底退出可调度集合，窗口才开始排空。结果是**额度饱和期间新旧任务一起停摆**，而不是「老任务继续跑、新任务排队」。

### 2. 额度按「启动过的任务」计数，重试也占额度

`j.lastStartedAt > now() - DAY` 不区分首次尝试与重试。一个 >24h 前启动过的失败任务被重试时，会消耗一个额度位。语义上 `PHOTO_REVIEW_DAILY_PLACES` 文档写的是「滚动 24h 最多处理的景点数」，与实际计数的「启动次数」不一致。

### 3. 零可观测性

`tick()` 在额度耗尽、选中任务上没有任何日志。全仓 `[photo-review]` 日志只有 3 处：未配置（`index.ts:78`）、任务失败（`photoReviewQueue.ts:86`）、队列读写失败（`:90`）。用户看到的只是「详情页没图」，服务端日志也看不出是被额度挡住、被重试占满，还是任务全都跑失败了。

## 量级

当前 271 个任务：`queued 168 / done 81 / failed 21 / running 1`。按 50/天硬上限，光积压的 168 个就需要 **≥3.4 天**才可能清完——这还没算每天新增的行程。

## 复现方式（无需真实外部请求）

`createPhotoReviewQueue` 支持注入 `run` / `now` / `dailyLimit` / `dataRoot`，可直接构造：50 个已启动任务占满窗口 → 断言新增任务在 N 次 tick 内不被选中。现有测试文件：`apps/server/src/__tests__/photoReviewQueue.test.ts`。
