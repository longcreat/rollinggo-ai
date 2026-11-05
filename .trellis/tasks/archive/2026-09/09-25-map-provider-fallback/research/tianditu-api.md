# 天地图 Web 服务 API 调研（09-25）

来源：天地图官方文档镜像 + 多方实现博客交叉验证。官方站点 `lbs.tianditu.gov.cn` 为 JS 渲染，
tavily_extract 取不到正文，故以搜索结果内嵌的官方文档表格 + 实现代码为准。
**所有字段名在实现前必须用真实 tk 打一次真实请求核对**（下文标 ⚠️ 的项风险最高）。

## 1. 端点总览

| 能力 | 端点 | 方法 | 返回体 |
|---|---|---|---|
| 地理编码（地址 → 坐标） | `https://api.tianditu.gov.cn/geocoder?ds={"keyWord":".."}&tk=..` | GET | JSON |
| 逆地理编码（坐标 → 地址） | `https://api.tianditu.gov.cn/geocoder?postStr={"lon":..,"lat":..,"ver":1}&type=geocode&tk=..` | GET | JSON |
| 地名搜索 V2 | `https://api.tianditu.gov.cn/v2/search?postStr={"keyWord":..,"level":..,"mapBound":..,"queryType":"1","start":0,"count":20}&type=query&tk=..` | GET/POST | JSON |
| 驾车路径规划 | `https://api.tianditu.gov.cn/drive?postStr={"orig":"lng,lat","dest":"lng,lat","style":"0"}&type=search&tk=..` | GET | **XML** |
| 步行路径规划 | **无独立端点** —— 走 `/drive` + `style=3` | GET | **XML** |
| 公交路径规划 | `https://api.tianditu.gov.cn/transit?postStr={...含城市信息...}&type=search&tk=..` | GET | **XML** |
| 骑行路径规划 | **不存在** | — | — |

### 文档页 vs 实际端点（重要）
文档页地址与 API 端点名**不一致**，以实际端点为准：

| 文档页 | 文档里的请求 URL | 实际端点 |
|---|---|---|
| `/server/drive.html` | `/drive` | ✅ 一致 |
| `/server/bus.html` | `/transit?type=busline` | ✅ 一致（文档页名不叫 transit） |
| `/server/search.html` | **`/search`** | ❌ `/search` 返回 404；实际是 **`/v2/search`** |

文档页本身是**服务端渲染**的（`Invoke-WebRequest` 直接 GET 就能拿到正文；tavily 提取不到不代表页面没内容）。

### 端点存在性（09-25 实测，不是照抄文档）

用「长度合法（32 位）但无效的 tk」探测可以判存在性：**真实端点回 `403 301001 非法key`，
不存在的端点回 `404` + 一个 HTML Error 页**。探测结果：

| 端点 | 存在 |
|---|---|
| `/geocoder`、`/drive`、`/transit`、`/v2/search` | ✅ |
| `/walk`、`/bus`、`/search`、`/transfer`、`/busline`、`/busroute` | ❌ |
| `/v2/drive`、`/v2/walk`、`/v2/bus`、`/v2/transit` | ❌ |

> **教训**：关于天地图路径规划的二手资料（博客、教程）普遍把端点写成 `/walk` 与 `/bus`，
> 实测两者均 404。**改动这里之前先用上表方法探一次端点，不要信博客。**
> 步行确实有规划能力，但它挂在 `/drive` 的 `style=3` 上（官方文档 `style` 取值：0 最快 / 1 最短 /
> 2 避开高速 / **3 步行**）。

密钥参数名是 `tk`（官方文档表格里写作 `appkey`，照表格写会一直鉴权失败 —— 已踩坑记录）。

支持 HTTP 与 HTTPS（政府站点常用 HTTP，我们统一用 HTTPS）。

## 2. 地理编码

正向：
- 入参 `ds` 必须是 **JSON 字符串**，不是对象：`ds={"keyWord":"北京市延庆区.."}`
- 返回：`{ status: "0", location: {lon, lat}, formatted_address, addressComponent: {province, city, district} }`
- ⚠️ `status` 是**字符串** `"0"` 表示成功，`=== 0` 永远失败
- `area` / `addressComponent` 里**没有 adcode**（六位行政区划码）

逆地理编码：
- `postStr={"lon":116.37,"lat":39.92,"ver":1}` + `type=geocode`
- 返回 `result.formatted_address` / `result.addressComponent` / `result.location`
- ⚠️ 官方表格字段拼写错误：`address_distince`（少 a），真实返回是 `address_distance`

**对我们影响**：`geoPipeline` 的 `adcodes` Map 靠 adcode 喂 transit 路径规划的 `city1/city2`。
天地图地理编码拿不到 adcode → 高德 transit 的那套 adcode 兜底在天地图下不可用。
天地图 bus 接口用**城市名**而不是 adcode，所以换 provider 后这个缺口不阻塞 —— 但 `GeocodedPlace.adcode`
仍会返回空串，消费方要容忍。

## 3. 地名搜索 V2

```
postStr = {
  keyWord: "北京大学",
  level: "15",            // 搜索等级
  mapBound: "116.37552,39.8935,116.42102,39.91804",  // 视野范围 西南经,西南纬,东北经,东北纬
  queryType: "1",         // 1 普通搜索 / 2 视野内搜索 / 3 周边搜索
  pointLonlat: "116.3,39.9",  // 周边搜索时的中心点
  queryRadius: "10000",
  start: 0, count: 20,
  show: 2,
}
GET /v2/search?postStr=<encodeURIComponent(JSON)>&type=query&tk=..
```

官方文档（http://lbs.tianditu.gov.cn/server/search.html）的必备参数表：

| 参数 | 必备 | 说明 |
|---|---|---|
| `keyWord` | 是 | 不支持 `'` 与 `&` |
| `mapBound` | **是** | 查询的地图范围 `"-x,-y,x,y"`（西南经,西南纬,东北经,东北纬） |
| `level` | **是** | 查询级别 1-20 |
| `queryType` | 是 | 1 普通 / 2 视野内 / 3 周边 / 4 普通建议词 / 5 公交建议词 / 6 公交起止点 / 7 纯地名 / 10 拉框（无 8、9） |
| `start` / `count` | 是 / — | start 0-300；count 1-300 |
| `specifyAdminCode` | 否 | **9 位国标码**（北京 156110000），优先级高于视野内 |
| `queryRadius` / `pointLonlat` | 周边搜索必备 | — |

响应：**JSON**（文档 2.1「响应的数据格式为json格式」），顶层 `resultType` / `count` / `keyword` / `pois[]` /
`statistics` / `area` / `suggests` / `prompt`。

返回（已确认）：
```json
{
  "status": { "infocode": 1000, "cndesc": "服务正常" },
  "count": "4539",
  "keyWord": "北京大学",
  "pois": [
    { "name": "北京大学", "address": "颐和园路5号", "lonlat": "116.303550,39.990460",
      "phone": "010-62752114", "poiType": "101", "source": "0", "hotPointID": "C0744404D108E731" }
  ],
  "prompt": [ { "type": 4, "admins": [ { "adminName": "海淀区", "adminCode": 156110108 } ] } ]
}
```

**字段缺口（已确认）**：`pois[]` 只有 name / address / lonlat / phone / poiType / source / hotPointID。
**没有** rating、cost（人均）、opentime（营业时间）、photos。
对照高德 `show_fields=business,photos` 返回的 rating / cost / opentime_today / photos[].url —— 全部缺失。

⚠️ **`queryType=1` 必须带 `mapBound`**（已实测，缺则 `infocode 2003`），且该接口**需要单独在控制台
配置权限**。实现上用 `/geocoder` 解析城市中心再取 ±0.5° 作为城市级视野，见第 6 节。

💡 文档里还有一个更好的候选但不适用：`specifyAdminCode`（9 位国标码）优先级高于视野，语义上更像
高德的 `region + city_limit`。但天地图的 geocoder **不返回任何行政区划码**，本项目也没有国标码表
（仓内的 `canonical_places.city` 是城市名不是码），故用不了 —— 除非以后引入一张城市→国标码表。

## 4. 路径规划（drive / transit）

### 参量（早于实测的推断；单位部分已被下文实测证实，`style` 语义已被推翻）
入参 `postStr`：`{ "orig": "lng,lat", "dest": "lng,lat", "mid": "lng,lat;lng,lat", "style": "0" }`
- `type=search`（`style` 取值见下文实测：文档的 `3` 不是步行）
- ⚠️ 是 **XML** 返回，不是 JSON。示例（经 showapi 网关转成 JSON 后的等价结构）：

```json
{
  "result": {
    "distance": "7.5",                                     // km（注意单位！）
    "duration": "542.0",                                   // 秒
    "orig": "116.35506,39.92277",
    "dest": "116.39751,39.90854",
    "routelatlon": "116.35506,39.92277;116.39751,39.90854;",  // 整条折线 lng,lat;lng,lat;
    "routes": { "item": [ { "strguide": "沿南池子大街走200米到达目的地。", "streetName": "南池子大街" } ] },
    "simple": { "item": [ { "streetLatLon": "116.35506,...;", "streetDistance": "353.0" } ] }
  },
  "ret_code": 0,
  "remark": "请求成功"
}
```

对我们的意义：`distance`（km→m ×1000）、`duration`（秒）、`routelatlon`（**整条路线折线一次给全**，
不需要像高德那样拼 `steps[].polyline`）。三者都能用针对性正则从 XML 里取，不需要完整 XML 解析器。

### drive（驾车）—— 已用真实 tk 实测
官方文档：http://lbs.tianditu.gov.cn/server/drive.html

```
http://api.tianditu.gov.cn/drive?postStr={"orig":"116.35506,39.92277","dest":"116.39751,39.90854","style":"0"}&type=search&tk=您的密钥
```
- `type=search`；postStr 键 `orig` / `dest` / `mid`（途经点，可选）/ `style`
- 返回 **XML**（`content-type: text/html`），不是 JSON；实测全量标签：
  `result, parameters, orig, dest, mid, key, width, height, style, version, sort, routes, item, strguide,
  signage, streetName, nextStreetName, tollStatus, turnlatlon, simple, streetNames, lastStreetName,
  linkStreetName, streetLatLon, streetDistance, segmentNumber, distance, duration, routelatlon,
  mapinfo, center, scale`
- `distance` 单位 **km**、`duration` 单位 **秒**、`routelatlon` 是**整条折线**（`lng,lat;lng,lat;…`），
  三者都在响应尾部（`<routes>` 之后），正则定点取即可，不需要 XML 解析器
- 实测样本（天安门 → 颐和园）：`distance=18.84` km、`duration=1200` 秒 → 20 分钟 / 56 km/h ✓

### ⚠️ `style` 取值的实测语义与文档不符（重要）
文档写 `0` 最快 / `1` 最短 / `2` 避开高速 / **`3` 步行**，实测：

| style | 天安门→故宫 | 天安门→颐和园 | 另一组（阜成门→故宫） |
|---|---|---|---|
| 0 / 1 / 2 | 1.85km / 160s | — | 7.5km / 542s |
| 3 | **0.9km / 97s**（33 km/h） | **17.3km / 27min**（38 km/h） | — |

- `0` / `1` / `2` 对同一对坐标返回**完全相同**的结果
- `style=3` 返回的是**更短但更慢的「驾车」路线**，不是步行 —— 97 秒走 0.9km、27 分钟走 17.3km，
  两者都是驾车速度（真步行应分别是 11 分钟与 4 小时）
- **结论：天地图没有步行路径规划**（`/walk`、`/v2/walk` 也均 404）。
  早期实现把 `walk` 接到 `/drive?style=3`，会让步行段拿到驾车时长（颐和园段少算 10 倍），
  而且 38 km/h 刚好落在速度闸门内、坏值会直写时间轴 —— 比启发式兜底糟得多，已移除。
- 仍保留 `style=0`（最快）给驾车。文档这一节是图片，无法从文本核对。

### 限流
无延迟连发同端点请求会返回 **429**（实测 6 连发即触发）。本项目与 geocoder 共用 350ms 串行队列，
实测 8 次连续调用（含 `/drive` 与 `/transit`）未触发 429，可继续沿用。
429 会被 `describeHttpFailure` 连响应体一起抛出，再由熔断器计入失败。

### transit
官方文档：http://lbs.tianditu.gov.cn/server/bus.html（文档页叫 bus，但**端点叫 /transit**）。

请求示例（官方原文，已验证参数名）：
```
http://api.tianditu.gov.cn/transit?type=busline&postStr={"startposition":"116.427562,39.939677","endposition":"116.349329,39.939132","linetype":"1"}&tk=您的密钥
```
- **`type=busline`**（不是 `search`）；postStr 键是**小写**的 `startposition` / `endposition` / `linetype`
  （文档表格把它们写成 `startPosition` / `lineType`，但**示例 URL 里是小写**；文档与实现不一致时以示例为准）
- `lineType` 按位：第0位=1 较快捷 / 第1位=1 少换乘 / 第2位=1 少步行 / 第3位=1 不坐地铁
- **没有城市参数** —— 天地图自行从坐标推断（早期实现按博客发了 `city`，无必要）
- `resultCode` 编码：0 正常 / 1 找不到起点 / 2 找不到终点 / 3 规划失败 /
  4 起终点 200m 内不规划（建议步行）/ 5 500m 内返回线路 / 6 输入参数错误
- 返回**最多 5 条互斥的完整候选方案**，层级是：
  `results[]`（按 lineType）→ `lines[]`（候选方案，≤5）→ `segments[]`（串联段）→
  `segmentLine[]`（**平行备选**线路）
  - **`lines[]` 只能取一条**（文档：「数组中每个对象为一条由起点到终点的公交规划线路」）——
    全累加会得到 53km / 4 分钟这种荒谬值
  - **`segmentLine[]` 只取第一个可用项** —— 全取会让该段时长翻倍（实测「特12外」与「44外」并列）
- **单位（文档未写，实测反推）**：`segmentTime` 是**分钟**、`segmentDistance` 是**米**
  - 310m 步行 = 7 分钟、8.2km 公交 = 26 分钟 → 均落在正常速度区间
  - 文档只写「此段线路需要的时间 Int」和「一条线路中每小段距离…Int」，都没写单位
  - 按秒解读会得到 804 km/h，被速度闸门拦下 → 整段静默降级成启发式（这正是早期实现的表现）
- **部分段返回负值表示不可用**（实测地铁段 `segmentTime=-2` / `segmentDistance=-15314`）→ 跳过；
  一条方案若全无可用量就试下一条（实测首选方案就是那条全负值的地铁方案）
- **没有总时长/总距离字段**，必须自行累加
- 实测样本（东直门 → 西直门）：首选方案「地铁2号线」全为负值 → 跳到方案2 = 7+26+12 = **45 分钟**、
  310+8199+520 = **9029 米**（12.0 km/h ✓）
- 文档还覆盖同端点的其他 `type`（ID 搜索、站点往返线路），本项目未用
- ⚠️ 结构（经网关转 JSON 的等价形式）：

```json
{
  "ret_code": 0, "hasSubway": true, "resultCode": 0, "remark": "请求成功",
  "results": [ { "lineType": 1, "lines": [ {
    "lineName": "地铁2号线 |",
    "segments": [ {
      "segmentType": 3,
      "stationStart": { "lonlat": "116.427561,39.939676", "name": "东直门站", "uuid": "121218" },
      "stationEnd":   { "lonlat": "116.349338,39.939135", "name": "西直门站", "uuid": "121230" },
      "segmentLine": [ {
        "lineName": "地铁2号线", "direction": "地铁2号线(积水潭站-积水潭站)",
        "linePoint": "116.427561,39.939676;116.349338,39.939135;",
        "segmentStationCount": 13, "segmentTime": -2, "segmentTransferTime": 0,
        "segmentDistance": -15314.004955268, "SEndTime": "05:04-22:15", "byuuid": "21518"
      } ]
    } ]
  } ] } ]
}
```

⚠️ 风险点：
- 官方文档未维护好这个接口（腾讯云文章直接吐槽「公交规划和驾车规划虽然是两个接口，但说明不明确」）
- 没有明确的「总时长 / 总距离」顶层字段，要自己把 `segments[].segmentLine[]` 的
  `segmentTime` / `segmentDistance` 累加；示例里 `segmentTime` 还是**负数**（-2），单位/语义不明
- 需要实测确认能否用累加得到可用的总时长
- **兜底**：累加不出合理值（≤0 或 NaN）时按路径规划失败处理，回落启发式
  （`legEstimator`），绝不让异常值进时间轴

### 坐标系
天地图用 **CGCS2000**（工程上与 WGS-84 等价，差异 < 1m，对行程规划可忽略）。
入参要 WGS-84 经纬度，返回也是 WGS-84。
我们库里全是 **GCJ-02** → 双向转换是硬需求：
- 出站：`gcj02ToWgs84`（`packages/shared/src/geo.ts` 目前**只有正向** `wgs84ToGcj02`，逆算法要新写）
- 入站：`wgs84ToGcj02`（已有）

逆算法用迭代逼近即可（正算法是确定性偏移，迭代 3~5 次收敛到 < 1e-6 度 ≈ 0.1m）。

## 5. 与高德的逐项对照

| 维度 | 高德 | 天地图 | 影响 |
|---|---|---|---|
| 密钥参数 | `key` | `tk` | 配置项 |
| 成功判定 | `status === '1'` | geocoder `status === '0'`；search `status.infocode === 1000`；drive/bus `ret_code === 0` | 判定逻辑各接口不同 |
| 返回格式 | 全 JSON | geocoder/search JSON，**drive/walk/bus XML** | 需 XML 取值 |
| 坐标系 | GCJ-02 | CGCS2000（≈WGS-84） | **必须双向转换** |
| 地理编码 adcode | 有 | **无** | transit 的 adcode 兜底失效（bus 用城市名，可绕过） |
| POI 字段 | 名称/类型/地址/评分/人均/营业时间/图片/adcode/坐标 | 名称/地址/坐标/电话/poiType | **评分/人均/营业时间/图片全缺** |
| 骑行规划 | `bicycling` | **无**（实测无任何候选端点） | 只能启发式 |
| 步行规划 | `walking` | **无**（`style=3` 实测是驾车最短路线，不是步行） | 只能启发式 |
| 公交规划 | `transit/integrated`，JSON，有总时长 | `/transit`，JSON，无总时长需自累加 | 已实测可用（层级与单位有坑） |
| 地名搜索权限 | 随 Key 可用 | **需单独申请** | 可能拿不到 |
| 折线 | `steps[].polyline` 需拼接 + 抽稀 | `routelatlon` 整条直给 | 天地图更简单（但仍要抽稀到 4000 字符） |

## 6. 实测记录与待确认清单

### 已实测确认（09-25，真实服务端 tk）

**HTTP 状态码语义（重要：三者含义完全不同，不能都当作「连不上」）**

| 情况 | HTTP | body |
|---|---|---|
| tk **长度**不对（如 16 位） | `400` | `{"code":308011,"message":"请求参数非法长度或不合规"}` |
| 参数缺失/不合规（随 tk 之后校验） | `400` | `{"count":0,"resultType":1,"status":{"cndesc":"缺少参数：mapBound","infocode":2003}}` |
| tk 长度对但无效 | `403` | `{"code":301001,"msg":"非法key","resolve":"请到API控制台重新申请Key"}` |
| tk 为空 | `418` | CloudWAF 的 HTML 拦截页（非 JSON） |

**校验顺序：先验 key，再验参数。** 用假 key 探参数组合是探不出来的 —— 403 会把参数错误完全挡住。
这直接导致了第一轮排查把 400 误判为「key 问题」。

**`/v2/search` 的 `queryType=1`（普通搜索）强制要求 `mapBound`。**
调用方只给城市名，故实现上先用同一 tk 的 `/geocoder` 解析城市中心，再取 ±0.5° 作为视野范围
（`apps/server/src/integrations/tianditu/poiSource.ts` 的 `cityBound`，按 region 24h 缓存）。
加不加 `mapBound` 不影响 key 校验，所以只能用**有效** key 才能发现这一条。

**适配器现在会把响应体带进报错。** 只回 `HTTP 400` 会把上表后三类混为一谈，
而设置页自检卡片是直接显示给用户的：`tianditu/http.ts` 的 `describeHttpFailure`。

### 待确认清单（失败时的退路已就位）

| # | 项目 | 失败时的退路 |
|---|---|---|
| 1 | ✅ 已实测：`/geocoder` 真实 tk 不报 301001（启动后可自检确认） | 地理编码走 Nominatim（现状） |
| 2 | ✅ 已实测：`/drive` 是 XML，`<distance>`(km) / `<duration>`(秒) / `<routelatlon>`(整条折线) 齐全（标签全表见第 4 节） | 只取 duration/distance，丢折线 |
| 3 | ✅ 已实测：`/transit` 是 JSON；**无 city 字段**；`segmentTime` 单位是**分钟**；`lines[]` 互斥必取一条（详见第 4 节） | transit 回落启发式 |
| 4 | `/v2/search` 权限是否已开通（需控制台单独配）；`pois[].lonlat` 字段名 | POI 回空数组 → 模型知识 |
| 5 | `mapBound` 跨度是否有未公开上限（本项目用 2°×1°） | 搜索失败 → 空数组降级 |
| 6 | `gcj02ToWgs84` 迭代精度 | 已验证：往返误差 < 1e-6 度（单测） |

## 7. 参考链接

- 官方文档入口：http://lbs.tianditu.gov.cn/server/geocoding.html 、`/search.html` 、`/drive.html`
- 逆地理编码字段与踩坑详解：https://www.ttfde.top/index.php/post/492.html
- 驾车规划参数 + XML 说明：https://cloud.tencent.com/developer/article/2745977
- 公交规划返回结构示例：https://www.showapi.com/apiGateway/view/3021/4
- 驾车规划返回结构示例：https://www.showapi.com/apiGateway/view/3021/3
- 地名搜索 V2 返回结构示例：https://www.showapi.com/apiGateway/view/3021/2
