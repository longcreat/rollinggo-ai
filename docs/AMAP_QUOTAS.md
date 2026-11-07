# 高德预算与日志

官方依据：[基础服务配额](https://lbs.amap.com/upgrade#price#base_service_price)、[流量限制说明](https://lbs.amap.com/api/webservice/guide/tools/flowlevel)，核对日期 2026-09-29。
通过 `smart-search fetch https://lbs.amap.com/upgrade --format markdown` 读取官方页面。

个人认证、无流量包的配额按服务组共享：基础 LBS 每月 150,000 次，包含地理编码及四类路线；基础搜索每月 5,000 次，包含 POI 定位和图片搜索。官方同时注明免费月配额权益自注册认证起一年，实际权益及 QPS 以控制台为准。

## 当前默认：只计量不拦截（2026-11-06 起）

`AMAP_QUOTA_ENFORCE` 默认 `false`：日预算只用于记账与观测，不再阻断外呼。计数照常写入 `amap_service_usage`，日志仍带 `used`/`limit`，超额时每种服务每个自然日输出一条 `over_budget`；`budgetRemaining()` / `remainingOf('place')` 返回 `Infinity`，因此 orchestrator 的 POI 源预检与 geoPipeline 的 provider 预检都不会把链路降级成 Null 源。

代价：实际消耗只受高德账户本身的月配额与 QPS 限制，月度超额不会被本系统挡住。需要恢复硬闸门时把 `AMAP_QUOTA_ENFORCE` 设为 `true` 并重启，下文的上限与校验随即生效。

## 默认分配

按用户要求不扣当前已用量，统一按最长月份 31 天向下取整，短月份也保持同一上限。

| 服务 | 配置项 | 默认每日上限 |
| --- | --- | ---: |
| 地理编码 | `AMAP_GEOCODE_DAILY_BUDGET` | 967 |
| 步行 | `AMAP_WALK_DAILY_BUDGET` | 967 |
| 骑行 | `AMAP_CYCLE_DAILY_BUDGET` | 967 |
| 驾车 | `AMAP_DRIVE_DAILY_BUDGET` | 967 |
| 公交 | `AMAP_TRANSIT_DAILY_BUDGET` | 967 |
| POI 定位及图片 | `AMAP_PLACE_DAILY_BUDGET` | 161 |

LBS：`floor(150000 / 31 / 5) = 967`，31 天最多 149,885 次；搜索：`floor(5000 / 31) = 161`，31 天最多 4,991 次。各服务可独立调整，五项 LBS 总和不得超过 `floor(AMAP_LBS_MONTHLY_BUDGET / 31)`，搜索不得超过 `floor(AMAP_SEARCH_MONTHLY_BUDGET / 31)`，否则启动失败。仅当 `AMAP_QUOTA_ENFORCE=true` 时配置为 0 才禁用该服务；负数、小数及非法值始终拒绝启动。

月预算默认 150000、5000；这是用于计算日上限的静态配置，不会向高德查询账户余额，也不是动态月度余额账本。旧 `AMAP_DAILY_BUDGET` 若保留，只压低未单独配置服务的默认值，例如旧值 600 对应五项各 600、搜索仍 161。要使用新的默认分配，请将旧值留空。修改环境配置后重启服务。

## 计量边界

- 生成、编辑器路线查询、POI 图片共用 `amap_service_usage` 表。所有站点及个人 Key 按服务共用全站计数，不存储 Key。
- 每次实际外呼前 PostgreSQL 原子扣减；缓存命中不扣，外呼失败/超时不退。数据库异常时拒绝外呼；上限只在 `AMAP_QUOTA_ENFORCE=true` 时生效，关闭后计数照写、并发与重启都不会被拦。
- 每天北京时间零点开始新计数。任务级上限和单进程串行间隔保留，日预算不等同于 QPS 限制。
- 旧 `generations.amap_calls` 仍是任务尝试统计，不是新预算账本。首次升级把近期旧混合统计保守计入每个服务，避免部署当日额度清零；可能导致首日提早降级。此迁移不用于推算高德本月余额。
- 升级时重启所有服务实例，勿混跑仍可绕过新账本的旧版本。不要手动清空计数表。
- 此规则只能限制本系统后续服务端调用。按要求未扣既有月用量，不能保证部署当月高德账户仍有余额；站外调用、前端 SDK 的共享服务调用、其他使用同账户的应用也不在服务端账本内。

## 日志查看

本地运行 `npm run dev:server` 的终端直接显示服务端日志。Docker 部署：

```sh
docker compose logs --since 30m -f app
```

搜索 `[amap-call]`，按 `service` 定位对应服务：

| outcome | 含义 |
| --- | --- |
| `local_budget_exhausted` | 系统日预算耗尽，包含 used、limit、resetAt；未向高德发请求（仅 `AMAP_QUOTA_ENFORCE=true` 时出现） |
| `over_budget` | 已超过日预算但仍放行；每种服务每个自然日只记一条，用于观察超额 |
| `upstream_rejected` | 高德拒绝请求，查看 infocode、info 区分配额/QPS/Key 等原因 |
| `budget_store_error` | 计数数据库不可用，已阻止外呼 |
| `timeout` / `network_error` / `http_error` / `invalid_json` | 请求或响应异常 |
| `success` | 成功，包含 used、limit、durationMs |

日志不记录 Key、完整请求 URL、地址或坐标。仓库旧 `dev.stdout.log` 等文件不一定是当前进程日志，不能据此判断账户已超额。

可在 PostgreSQL 查看今天各项已计数请求：

```sql
SELECT service, calls
FROM amap_service_usage
WHERE day = (extract(epoch FROM
  (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')) * 1000)::bigint::text
ORDER BY service;
```

`day` 保存当天北京时间零点的毫秒时间戳文本。每项 limit 来自运行环境配置，不写入表中。
