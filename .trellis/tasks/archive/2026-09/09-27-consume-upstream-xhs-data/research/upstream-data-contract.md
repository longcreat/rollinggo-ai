# 调研：上游 xhs-travel-pipeline 数据契约（三份产物）

调研时间：2026-09-27 ｜ 上游 HEAD `47292c6`（工作区有未提交改动，见文末）
调研方式：读上游源码 + 直接查本地 tripweaver PG（`canonical_places`）+ 读 `import/*.json` 统计

---

## 1. `payload.openHours`（结构性开闭馆）

**来源**：上游 commit `f031241` — `app/clean/hours.py:mine_open_hours()`，
由证据原文 + 图片事实合并挖掘，导出脚本 `scripts/export_to_tripweaver.py` 写入 `payload.openHours`。

**格式**（实测于本地库，`canonical_places.payload.openHours`）：

```jsonc
{
  "text": "09:00-17:00",          // 原始匹配文本
  "openTime": "09:00",            // 可空
  "closeTime": "17:00",           // 可空
  "closedWeekdays": [],           // int 数组，0=周日 … 6=周六（与 Date.getDay() 一致）
  "note": "",                     // 补充说明，常为空
  "evidence": ["..."]             // 挖掘依据原文片段
}
```

**实测样本**：

| 地点 | openHours |
|---|---|
| 景山公园 | `{text:'06:30-20:00', openTime:'06:30', closeTime:'20:00', closedWeekdays:[]}` |
| 国博 | `{text:'09:00-17:00', openTime:'09:00', closeTime:'17:00', closedWeekdays:[]}` |
| 香山双清别墅 | `{text:'周一闭馆', openTime:null, closeTime:null, closedWeekdays:[1]}` |
| 环球影城 | `{text:'09:30-19:30', openTime:'09:30', closeTime:'19:30', closedWeekdays:[]}` |

**DB 覆盖实况**（`payload ? 'openHours'` / 该城总行数）：

| 城市 | 有 openHours | 总行数 | 覆盖率 |
|---|---|---|---|
| 北京 | 67 | 1349 | 5.0% |
| 杭州 | 20 | 670 | 3.0% |
| 广州 | 11 | 714 | 1.5% |
| 厦门 | 4 | 667 | 0.6% |
| 成都 | 4 | 411 | 1.0% |

→ **覆盖率是这项工作的主要限制**：接入后大多数地点仍走原有 `closureText` 正则兜底。

---

## 2. `payload.aliases`（权威别名数组）

**来源**：上游 commit `f031241` — `app/clean/alias.py` 的 `_ALIAS_MAP`（城市维度人工表），
`aliases_for(city, name)` 产出，导出为 `payload.aliases: string[]`。

**格式**：`["故宫", "紫禁城"]` —— 纯字符串数组，不含正名本身。

**DB 覆盖实况**：北京 17 / 1349，成都 12 / 411，广州/杭州/厦门 0。

**上游工作区新增（未 commit）**：`_ALIAS_MAP` 补了「后海→什刹海」「前门大栅栏→大栅栏」等片区归并。
未提交 → 本次不依赖。

---

## 3. `place_relation`（无向 POI 关联对）

**来源**：上游 commit `47292c6`（重写）+ `0c5b044`（修误判）。
脚本 `scripts/mine_place_relations.py`，规则法（非 LLM），从笔记原文挖「常在同天/相邻」的地点对。

**关键语义（上游注释原文）**：

> 产出无向关联对：同一对地点只存一行（from_name < to_name），**不表达先后** ——
> 顺序（「先去 A 再去 B」）由消费端用坐标/营业时间/种子表等确定性规则决定。

→ **不能当 `routeOrderSeeds`（有向先后硬约束）使用**，否则造出假方向。

**挖掘信号**：顺序类（出来就是 / 分钟到 / 紧挨 / 出门就是）、视线类（俯瞰 / 正对 / 眺望 / 隔岸看）、
路线类（箭头 → / 顺路 / 再去 / 下一站 / 步行可达）。
跨句末标点、跨日程标记（Day2 / 第3天）判为不关联。

**`strength`**：≥2 篇笔记支持 → `direct`；单篇 → `weak`。

**JSON 格式**（`D:\Project\tripweaver\import\xhs-place-relations-{city}.json`）：

```jsonc
{
  "_comment": "北京 POI 关联对（... 规则挖掘，2026-09-25）；无向，顺序由消费端决定",
  "city": "北京",
  "count": 258,
  "relations": [
    {
      "from": "故宫博物院",
      "to": "景山公园",
      "strength": "direct",
      "noteCount": 9,
      "evidence": "胡同线 天安门广场→故宫博物院→景山公园→恭王府→南锣鼓巷→",
      "sourceUrl": "https://www.xiaohongshu.com/explore/..."
    }
  ]
}
```

**文件实况**（`import/` 目录，注意 `count` 字段与实际数组长度可能不一致 —— 上游导出时 count 取的是写库前
的 rows 长度）：

| 城市 | 总数 | direct (noteCount≥2) | weak |
|---|---|---|---|
| 北京 | 258 | 79 | 179 |
| 杭州 | 224 | 72 | 152 |
| 厦门 | 207 | 75 | 132 |
| 广州 | 105 | 22 | 83 |
| 成都 | 75 | 22 | 53 |
| **合计** | **869** | **270** | **599** |

`import/xhs-place-relations-北京.json` 等 5 个文件时间戳 2026-09-25 / 09-26，
**均已用 47292c6 的格式**（无 `type` 字段，只有 `strength`）。北京文件是 `47292c6` 之前的产物但格式已统一。

**注意**：`canonical_places` 在 tripweaver DB 里，但 `place_relation` **不在** —— 上游的
`place_relation` 表只存在于 xhs-pipeline 自己的库。tripweaver 侧需要新建。

---

## 4. 名字匹配的坑

关联对与 aliases 里的名字是**上游的 canonical name**（如「故宫博物院」），
候选池里的名字来自调研阶段（可能是「故宫」）。两边必须经过归一键对齐。

消费端已有 `placeFacts.ts:normalizePlaceKey()`（剥机构后缀：博物院/公园/博物馆/风景区…）。
`routeOrderSeeds.ts:matchesName()` 是另一套（别名 ≥3 字包含匹配，≤2 字只全等）。

**本任务的归一键选择**：关联对两端各自 `normalizePlaceKey()` 后排序成 pair key，
与候选池名字同样处理后比对。不引入第二套归一规则。

---

## 5. 未提交的上游改动（本次不消费，仅记录）

`git status` 显示上游工作区有以下未提交改动，**不构成消费契约**：

- `app/config.py` + `app/resolve/amap.py`（313 行重写）：高德 Web 服务 → **天地图**（tianditu）
- `app/models.py` + `app/vision/classify.py`（新增）：`note_image` 表 + CLIP 图片分类
- `app/clean/alias.py`：`_ALIAS_MAP` 补片区归并
- 新增脚本 `fetch_scenery_images.py`、`tests/test_geo.py`

其中 `tests/test_alias.py` 有改动，但未提交 → 上游 aliases 表内容以 DB 现有值为准。

---

## 6. 消费端接线点（已确认的代码位置）

| 产物 | 读取位置 | 最终生效点 |
|---|---|---|
| `payload.openHours` | `placeFacts.ts:toFacts()` | `SchedulablePoi.openTime` → `isClosedOnDate()` 闭馆日避让 + feasibility `closed_on_arrival` |
| `payload.aliases` | `placeFacts.ts:normalizePlaceKey()` 的调用侧 | `mergeFacts()` 合并 → 分数/提及/时长归并 |
| `place_relation` | 新模块 `scheduling/placeRelations.ts`（DB 查询） | `buildSchedule` options → `buildChain` 最近邻距离折扣 |

**排程链路**（`schedule.ts`）：
入选（按 `weight` 分量贪心装填）→ `buildChain` 全局最近邻成链 → `cutChain` 按每日分量上限切段
→ 段按分数降序分配 Day1..k → 餐次插槽 → 空天占位。

「同天」= 同一段。让关联对在链上相邻，就近似等于让它们同日。
