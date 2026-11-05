# 行程天气与出行手册

## 1. Scope / Trigger

行程生成时的目的地天气快照、旧行程补查、详情按出行日期展示及天气相关建议。天气是可选增强，不能冒充历史天气或长期预报。

数据源为**和风天气（QWeather）**；2026-10-04 起完全取代此前的高德天气适配器（`AMAP_WEATHER_DAILY_BUDGET`、`weather` 服务项、`integrations/amap/weather.ts` 已删除，不做供应商回落）。

## 2. Signatures

- `getTripWeather(trip): Promise<TripWeather>`（**不再接收 userId**：凭据是站点级）；主生成流程在事务前查询并写入 `completedDraft.weather`，随后保留取消检查与原子落库。
- `GET /api/trips/:id/weather`，`requireAuth` + `getTrip(userId, id)` 归属检查，响应遵循统一 `{code,message,data}`。
- `qweatherRequest(host, path, params, auth, timeout?, signal?)`；`createQWeatherLookup(request?, deadlineMs?): (host, auth, destination) => Promise<WeatherForecast | null>`；`lookupQWeather`。
- 认证：`QWeatherAuth`（`api-key|token|jwt`）、`qweatherAuthHeader(auth, now?)`、`signQWeatherJwt(auth, key, now?)`、`parseQWeatherPrivateKey(pem)`、`qweatherIdentity(auth)`、`looksLikeJwt(value)`。
- 纯解析：`parseQWeatherCity(body)`、`parseQWeatherDaily(body, city, locationId)`、`chinaTimestamp(value)`。
- 共享 `WEATHER_FORECAST_DAYS`(15) / `TripWeatherSchema` / `WeatherForecastSchema` / `weatherForDate(snapshot, destination, date?, now?)`。
- `Trip.weather?` 为 JSON 中的可选字段，不需要数据库列迁移；独立天气 GET 不更新 Trip 或创建版本。

## 3. Contracts

- 站点级凭据：`QWEATHER_API_HOST`（控制台-设置的**专属域名**，形如 `abcxyz.qweatherapi.com`）与凭据，两者缺一即 `not_configured`。Host 也是身份认证的一部分，不能回落 `api/devapi/geoapi.qweather.com`（自 2026 年起逐步停服）。env 会剥掉协议与尾斜杠，请求前再用主机名正则校验。
- 凭据三选一，优先级 JWT 签名 > 静态 JWT > API Key（`qweatherCredential()`）：
  - **JWT 签到（推荐）**：`QWEATHER_JWT_KEY_ID`(kid) / `QWEATHER_JWT_DEVELOPER_ID`(iss) / `QWEATHER_JWT_PROJECT_ID`(sub) / `QWEATHER_JWT_PRIVATE_KEY`(Ed25519 PKCS8 PEM，多行可写成 `\n`)，**四项齐备才算可用**（部分配置启动时告警）。
  - **静态 JWT**：`QWEATHER_KEY` 填已签好的 token（`eyJ` 开头三段）→ 自动走 `Authorization: Bearer`。token 最长只有 24 小时，仅供临时排查。
  - **API Key**：`QWEATHER_KEY` 填普通 Key → 走 `X-QW-Api-Key` 头。和风自 2027-01-01 起限制 API KEY 的每日请求数。
- JWT 用私钥现签，**不需要人工更新 token**：`iat` 回拨 30 秒容忍时钟误差，`exp = iat + 900`（和风上限 24 小时），进程内按 kid+iss+sub 缓存签名结果，剩余不足 5 分钟自动重签。私钥不失效，除非换密钥对（需重新上传公钥）。
- 凭据只走请求头，**不进 URL**；日志只记路径、认证方式（`mode`）、结果、用量与耗时，凭据、查询串、上游响应体一律不入诊断。私钥解析失败在**消耗额度之前**报 `auth_error`。
- 两步协议，每个目的地各最多一次：
  - `GET https://<host>/geo/v2/city/lookup?location=<目的地>&number=2&lang=zh` → `/location[0]` 的 `id`/`name`。
  - `GET https://<host>/v7/weather/15d?location=<LocationID>&lang=zh` → `daily[]`。
- 同名多候选必须放弃（例如「朝阳」同时是北京朝阳区与辽宁朝阳市）：`number=2` 后若第二条候选与首条 `name` 相同即返回 null，**不静默取第一条**。
- `/v7/weather/{days}` 只接受 `3d/7d/10d/15d/30d`；**该 v7 城市接口已公告 2027-06-01 停服**，替代品 `/weather/v1/daily/{lat}/{lon}?days=N` 上限 10 天。跨度常量来自 `WEATHER_FORECAST_DAYS`，真要降到 10 天只需改常量与路径档位。
- 响应 `code` 必须为 `'200'` 才算成功；`updateTime`（ISO 带时区）统一归一化成中国时间的 `YYYY-MM-DD HH:mm:ss`。字段映射 `fxDate→date`、`textDay/textNight→昼夜天气`、`tempMax/tempMin→昼夜温度`、`windDirDay/windDirNight→风向`、`windScaleDay/windScaleNight→风力`。
- 风向归一化：和风返回「东北风」，契约里的 `dayWind/nightWind` 是**纯方位**（「东北」），由展示层拼「风」字，适配层负责去掉后缀，避免出现「东北风风」。
- 逐日容错：适配层**按天单独校验** `WeatherCastSchema` 与日期。某天缺温度/天气文字或值越界、日期非法，只丢弃这一天，不拖垮整份 15 天预报（因为上层按 `date` 匹配，不按数组序号）；全部非法才返回 null，绝不伪造缺失字段。风字段缺失落空串，不算非法。
- 计量：复用 `amap_service_usage` 这张通用 `(day, service, calls)` 表，`service='qweather'`；`QWEATHER_DAILY_BUDGET` 默认 200，0 关闭，是应用上限而非官方套餐额度（官方免费档为每月 5 万次请求）。与六项高德服务天然隔离，不占 LBS 日预算、不影响地理增强剩余额度。
- 无串行队列（和风不需要和高德共享限流通道）：靠同请求合并、`pending` 上限 30、单请求 5 秒、整次查询 12 秒截止。截止触发会 abort 进行中的请求，因此超时后不会再有上游请求发出。
- 缓存按凭据（Host+Key 的 SHA-256）与目的地隔离，城市 24 小时、预报 1 小时、失败 1 分钟，每类最多 300 条；预报缓存键包含中国日期。所有缓存/合并均为单进程。
- `TripWeather`：`destination`、`checkedAt`、`status` (`available|unavailable|not_configured|not_needed`)、可选 `forecast`。预报包括 `city/locationId/reportTime/casts`；casts 最多 15 条，字段含日期、昼夜天气、数值气温、风向、风力。
- 覆盖窗口是**当天起 15 个自然日**，按中国 UTC+8 计算今天；未定日期、历史、窗口外、服务失败分开提示。第 8 天起 `weatherForDate` 返回 `distant: true`，前端标注「远期预报仅供参考」——超过一周的预报只能当趋势，不能当结论。
- 快照查询时间超过 3 小时、报告超过 24 小时、目的地不匹配或日期不在 casts 中时不能显示具体天气事实。0℃、负温均合法。

## 4. Validation & Error Matrix

| 条件 | 行为 |
| --- | --- |
| 未登录 / 不属于本人或不存在 | 401 / 404，零外部请求 |
| 所有日期未定、已过去或 15 天窗口外 | `not_needed`，不读凭据、不消耗上游额度 |
| Host 或 Key 缺一 | `not_configured`，详情可正常使用 |
| 超时、拒绝、额度耗尽、格式错误、城市同名多候选 | `unavailable`，不阻断生成 |
| 数字/日期/城市不合法 | 单独的非法日丢弃，其余照常展示；全部非法则丢弃预报，不伪造缺失字段 |
| 刷新天气 | 只返回查询数据；不改变编辑草稿、revision、自动保存或版本链 |

## 5. Good / Base / Bad Cases

- Good：10 月 4 日查询 10 月 5 日行程，以 casts 中 `2026-10-05` 匹配，无关数组排序。
- Base：下个月的行程显示「预报待更新」；临近出行打开详情再查询。
- Bad：把今天晴天复制到未来行程，或让模型补全不可用的天气。

## 6. Tests Required

- `qweatherWeather.test.ts`：真实零/负温、`updateTime` 归一化、风向去后缀、日期/城市/温度非法值、单日非法不拖垮整份预报、重复 casts、同名多候选、乱序 casts、UTC+8、`distant` 边界（第 7/8 天）、陈旧数据、缓存合并与凭据隔离、失败恢复、12 秒截止与 abort、无调用路径。
- `qweatherRequest.test.ts`：日界 UTC+8、额度耗尽、计量故障、非法 Host 不消耗额度、**JWT 能用公钥验签且 iat/exp 正确**、三种认证头与提前重签、**坏私钥在配额之前失败**、凭据走头部且不入 URL/日志、上游 `code` 拒绝、跨日重新占用。
- `amapRequest.test.ts`：高德六项服务预算与路径（已不含 weather）。
- `scripts/verify-trip-weather.mts`：本地临时数据库和模拟和风，**走真实 JWT 私钥现签链路**（断言上游收到的 token 能用公钥验签），验证鉴权/归属、响应 schema、持久额度、缓存、旧行程补查不写版本、快照往返。运行前会强制清掉 `.env` 里的真实凭据，避免开发机配置渗入。
- `tripAdvice.test.ts`：只对行程真实日期的有效预报生成天气建议，预约去重。
- `trip-weather-browser.mjs`：默认总览、逐日天气、来源文案、建议/提醒、加载重试、远期/未定日期、无写请求、390/768/1600px。

## 7. Wrong vs Correct

错误：`forecast.casts[day.dayIndex - 1]`，或天气请求写回编辑器并触发自动保存。

正确：`weatherForDate(weather, trip.destination, dateForDayIndex(trip.startDate, day.dayIndex))`；React Query 单独持有当前天气。

官方来源：https://dev.qweather.com/docs/api/weather/weather-daily-forecast-webapi-v7/、https://dev.qweather.com/docs/api/geoapi/city-lookup/、https://dev.qweather.com/docs/configuration/api-host/、https://dev.qweather.com/docs/configuration/authentication/
