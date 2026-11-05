# 手写体分片按真实文案重排

## 背景

`scripts/build-handwriting-font.py` 把悠然小楷切成 76 片：`CORE_BLOCKS` 手工列了几十个城市/景点字，其余按码位每 96 字一片。

实测（`tailwind.css` 分片表 + 真实文案）：

| 标题 | 命中分片 | 体积 |
| --- | --- | --- |
| 紫竹院 | 3 | 198 KB |
| 奥林匹克公园 | 6 | 366 KB |
| 首钢园 | 3 | 203 KB |
| 古北水镇 | 4 | 232 KB |
| 鲁迅博物馆 | 4 | 251 KB |

生成页 5 张拍立得卡片，20 个汉字要拉 16 片、约 1.1 MB。每片都是独立的 `font-display: swap` 请求，先到的字先换字体，屏幕上出现「一部分字手写体、一部分系统黑体」的混杂帧，并逐字跳动。

## 目标

按真实文案重排分片，让一个标题尽量只命中一片。

实测结论：做不到「1 片」。跨标题共享的高频字（园/山/街/馆）只能落在一个片里，任何包含它们的标题都至少要拉 2 片；把同一字形复制进多片的做法无效（`unicode-range` 重叠时浏览器只用第一个匹配的 face）。因此实际目标定为：

- 生成页 5 张卡片合计 ≤ 8 片 / ≤ 500 KB（现状 16 片 / 1.1 MB）
- 单个标题命中片数 ≤ 3（现状 3~6）
- 公共字单成一片，所有文案共用，只需加载一次

## 方案

1. 新增 `scripts/extract-handwriting-corpus.mts`：连 `DATABASE_URL`，读 `canonical_places.name/city`、`trips.destination`、`trips.data.days[].title`，得到文案条目集合。
2. 装箱：条目按字频权重降序，以**条目为单位**贪心填片（每片 ≤ 96 字）；一条目放不下就整条开新片，保证共现的字同片。剩余字形仍按码位切块。
3. 导出 `scripts/handwriting-chunks.json`（只含字符列表，不含原文，不含 DB 凭据），由 `build-handwriting-font.py` 读取替代 `CORE_BLOCKS` + 纯码位切分。
4. 重跑 `build-handwriting-font.py` 生成 woff2 与 `tailwind.css` 的 `@font-face`，再跑 `scripts/generate-title-font-coverage.py` 同步 `packages/shared/src/handwriting.generated.ts` 与 `apps/server/src/generation/titleFont.generated.ts`。

## 范围外

- 不改字形、不改字体源、不换字体
- 不改 `handwritingFallback` 的缺字整段降级策略
- 不做 preload / `font-display` 策略调整（另议）

## 验收标准

- [x] 用脚本核对：5 个抽样标题合计 7 片 / 428 KB（原 16 片 / 1.1 MB），单条 2~3 片
- [x] `tailwind.css` 的 90 组 `unicode-range` 无重叠、无遗漏（覆盖源字体 6955 个码位）
- [x] `packages/shared` 覆盖率清单与实际 woff2 cmap 一致（`generate-title-font-coverage.py --check` 通过）
- [x] `node --import tsx --test apps/web/tests/handwriting.test.ts` 通过
- [x] `node --import tsx --test apps/server/src/__tests__/titleFont.test.ts` 通过
- [x] `npm run -w apps/web build` 通过，产物 CSS 引用的 90 个分片文件全部存在

## 实测结果

| 标题 | 改造前 | 改造后 |
| --- | --- | --- |
| 紫竹院 | 3 片 / 198 KB | 2 片 / 128 KB |
| 奥林匹克公园 | 6 片 / 366 KB | 2 片 / 126 KB |
| 首钢园 | 3 片 / 203 KB | 3 片 / 134 KB |
| 古北水镇 | 4 片 / 232 KB | 2 片 / 123 KB |
| 鲁迅博物馆 | 4 片 / 251 KB | 3 片 / 203 KB |
| 五张卡去重 | 16 片 / 1101 KB | 7 片 / 428 KB |

代价：分片数 76 → 90，`tailwind.css` 里字体块 50 KB → 64 KB（gzip 后增量约 5 KB）；字体总量 5.62 MB → 5.97 MB（多出的都是每片 woff2 表头开销）。

## 后续（未做，另议）

- 首屏 `<link rel="preload">` 公共字片（`youran-00-*.woff2`，53 KB），把生成的混杂帧窗口再压小
- 卡片标题等待 `document.fonts.load()` 就绪再切手写体，彻底消除逐片 swap 的粗细混排
