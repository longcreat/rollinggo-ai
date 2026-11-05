# 账号旅行偏好

## 1. 适用范围

首页“偏好与出行”“节奏与同行”共用当前账号最近一次偏好设置。2026-10-05 已删除导航“个人资料”入口，保留底层字段组件。保存偏好标签、交通方式、旅行节奏、同行人数与备注；目的地、日期及多套历史不在此契约中。

## 2. 接口与存储

- `GET /api/settings/travel-preferences` 返回当前设置。
- `PUT /api/settings/travel-preferences` 整包替换当前设置。
- `TravelPreferencesSchema` 定义 `{ preferences, transportMode, pace, partySize, extraNotes }`；类型从 schema 派生。
- `pace` 允许 `null`（账号还没选过节奏，首页据此保持提交按钮未就绪）；`partySize` 为 1~20 的整数。
- `user_travel_preferences(user_id PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ)`；启动时幂等建表，独立于凭据设置。

## 3. 数据约定

接口复用 `requireAuth` 与 API envelope，userId 仅取会话。preferences 使用现有枚举、最多 7 项且不重复；transportMode 使用已有枚举；pace 使用 `PACE_OPTIONS` 或 `null`；partySize 为 1~20 的整数；extraNotes 最多 200 字。无记录返回空偏好、transit、`pace: null`、`partySize: 2`、空备注。清空即写入该默认值。

读取先把库里的行补齐再用 schema 校验：`Value.Default(TravelPreferencesSchema, row.data)` 只会填带 `default` 的缺省字段（正好是 `pace` / `partySize`），于是上一版三字段的行能正常读出，而缺字段、类型错误、未知字段、非法 pace 仍会在 `Value.Check` 处失败，不会伪装成新账号默认值。`pace` / `partySize` 的缺省值因此有两处声明（schema 的 `default` 与「无记录」返回值），改动时同步。

PUT 使用路由级 `validatorCompiler` 和 `@sinclair/typebox/value` 的 `Value.Check` 校验原始 body；禁止 AJV 默认类型转换或移除未知字段，避免 `extraNotes: null` 被转换成空备注而覆盖旧记录。当前共享 schema 属于 `@sinclair/typebox`，不要混用另一套 `typebox` validator。

`TravelPreferencesProvider` 放在 AppLayout，按 userId 重建；本地草稿覆盖服务器快照，不自动写库。当前可达入口为首页：

- 首页只写本地草稿，不调 PUT。`GenerationProvider.start(form)` 从实际表单构造偏好快照，任务成功后调用 `persist(snapshot)`；页面切换保留草稿，失败不保存，刷新/退出/账号切换丢弃草稿。409 接管不保存当前表单。旧任务成功不能把首页后来的新选择误存到账号，也不能清除新草稿。
- 原个人资料弹窗与 autoSave 组件仍保留代码，但导航无入口，不作为当前产品可达流程。

首页的「节奏与同行」与「偏好与出行」共用同一份草稿：面板初值直接读账号快照（`value.pace` / `value.partySize`），选择只调 `change`；偏好还没加载完时这些控件置灰，避免点了没反应。个人资料弹窗**不提供**这两个控件，但它的「清空」必须把 `pace` 与 `partySize` 一起复位，否则账号里的节奏无法清除。

`persist(snapshot?)` 写显式提交快照或当前草稿（两者皆空则不发请求），mutation scope 串行写入，成功回执只清除它实际写过的草稿，不能清掉在途的新修改。Provider 挂在布局层，导航不卸载保存主体；登录期间切换账号会按 userId 重建 Provider，旧队列随作用域取消。退出按钮在写入中禁用。失败保留草稿并提供重试；首页草稿的失败会留到下次打开面板才可见。

每笔 mutation 真正发送前核对 React Query 的 `keys.me` 与该笔保存的 userId；会话失效或账号切换后拒绝旧队列。成功回执同样核对身份，不能在退出清缓存后重新填入旧账号数据。串行 scope 只协调当前页面内的写入，不提供跨设备冲突合并。

首页通过现有参数链路传 extraNotes，NewTripPage 同时写入 Brief 和 GenerateForm；后续账号设置变化不改写生成快照或已有行程。

## 4. 校验与错误

| 情况 | 行为 |
| --- | --- |
| 未登录 | 401，走统一会话失效处理 |
| 标签重复、枚举非法（含 pace）、人数非 1~20 整数、备注超长、null/错误类型、缺字段、附加 userId 等未知字段 | 400，原记录不变，不做隐式转换 |
| 库里是上一版三字段格式（无 pace / partySize） | 按缺省补齐读出，不报错 |
| 库内数据缺失必填字段、未知字段或非法 pace | 500，不被缺省补齐掩盖 |
| 无偏好记录 | 返回默认值，不写库 |
| 保存失败 | 显示尚未记住并保留输入，可重试；首页草稿的失败留到下次打开面板可见 |
| 读取失败 | 显示重试，不将默认值当已保存值覆盖账号 |
| 库内数据非法 | 500，不伪装成新账号默认值 |
| 存储读写失败 | 500，统一错误 envelope，不泄露表名和 SQL，原记录保持不变 |

## 5. 正常与反例

- 正常（首页）：用户输入“带小孩一起”、勾选「美食」、选「轻松悠闲 / 4 人」→ 不写库；生成行程成功后才一次性写入账号，刷新/重新登录恢复，生成输入和 Brief 同时收到备注。
- 正常（节奏与同行）：重开首页时节奏与人数直接从账号带出，不必重选即可提交。
- 正常（后台生成）：旧任务成功记住其提交快照，首页新草稿保持；快照保存失败保留提示，重试原快照。
- 基线：新账号默认为公共交通、无偏好、无备注、节奏未选、2 人。
- 反例：首页每次勾选都写账号；仅保存在 localStorage；GET 完成时自动写默认值；旧 PUT 回执清除用户新输入；生成失败也把草稿写进账号；把 pace/partySize 只放在组件 state 或 localStorage；个人资料「清空」留下 pace。

## 6. 验证

- `node --import tsx scripts/verify-travel-preferences.mts`：独立临时 PostgreSQL 数据库（默认 18797，可用 `VERIFY_PREFERENCES_ADMIN_URL` 指向测试实例；本机只有 5432 时指向 5432 即可，脚本只建/删自己的临时库），检查重复迁移、旧设置保留、401、非法输入（含 pace 枚举、partySize 越界与类型）、两个账号、重新登录、清空，以及上一版三字段行的缺省补齐、库内数据损坏和读写故障；故障恢复后读取原值。
- `node --import tsx apps/web/tests/travel-preferences-browser.mjs`：默认 5173；mock API 验证首页仅生成成功后保存、失败与刷新不写账号、偏好加载/保存失败重试、图标退出与账号隔离、移动端边界。生产链路的并发新草稿验证见 `scripts/verify-generation-browser.mjs`。
- `npm run typecheck` 与 `npm run build -w apps/web`。

## 7. 错误与正确示例

```ts
// 错误：任何旧请求完成都丢弃新输入。
setDraft(null);

// 正确：仅清除该请求实际保存过的草稿。
setDraft(current => current === submittedDraft ? null : current);

// 错误：change 里直接写库，首页每次勾选都扣一次 PUT。
change = (value) => { setDraft(value); void send(value); };

// 正确：change 只改草稿，由生成成功 / 个人资料自动保存调 persist。
change = (value) => { setDraft(value); };
persist = async () => { const snapshot = draftRef.current; if (!snapshot) return; await send(snapshot); };

// 错误：直接把库里的行当偏好返回 —— 上一版没有 pace/partySize，前端 Value.Check 会抛「偏好设置格式异常」。
return row.data;

// 正确：先补 schema 缺省再严格校验；未知字段与非法 pace 照样过不了 Check。
const data = Value.Default(TravelPreferencesSchema, row.data);
if (!Value.Check(TravelPreferencesSchema, data)) throw new Error('Invalid stored travel preferences');
return data as TravelPreferences;

// 错误：节奏放在首页组件 state 里，离开首页即丢。
const [pace, setPace] = useState<TripPace | null>(null);

// 正确：初值读账号快照，选择只写草稿。
const pace = saved?.pace ?? null;
const changeDraft = (patch: Partial<Pick<TravelPreferences, 'pace' | 'partySize'>>) => {
  savedPreferences.change({ ...saved, ...patch });
};
```
