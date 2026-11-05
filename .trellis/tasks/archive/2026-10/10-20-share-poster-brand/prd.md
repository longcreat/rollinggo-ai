# 分享海报加品牌带与二维码

## Goal

AI 生成的行程海报是目前唯一会被用户转发出去的产物，但图上只有模型画的「AI 创作 · 织程」角标（中文长文本模型经常画错），没有域名、没有二维码。别人看到一张漂亮的海报，不知道去哪试。

在海报底部合成一条品牌带：左域名与产品标识，右二维码指向站点首页。每张被转发的图都成为一次可追溯的曝光。

## 现状证据

- 海报由 `apps/server/src/services/tripShareImageService.ts` 的 `produce()` 生成：`generate(prompt)` → `store.save({bytes, mimeType})`，落盘 `data/media/share-posters/<sha256>.<ext>`
- 尺寸 1024×1536，风格 `journal`（旅行手账）/ `ink`（水墨写意），见 `apps/server/src/lib/tripSharePrompt.ts`
- `docs/AI_SHARE_IMAGES.md` 已记载「图片包含"AI 创作 · 织程"角标；模型可能存在文字或细节偏差」—— 即当前品牌信息依赖模型绘制，不可靠
- 无图片处理依赖（`package.json` 里没有 sharp / jimp / canvas / qrcode）
- 生产镜像是 `node:22-alpine`，无中文字体

## Requirements

### R1 品牌带合成

在 AI 生图成功、`store.save` 之前插入合成步骤：

- 画布高度从 1536 → 1632，底部 96px 为品牌带
- 品牌带左侧：`sakiiko.com`（主）与「织程 TripWeaver · AI 生成」（次）
- 品牌带右侧：72×72 二维码（白底 padding 8px），指向站点首页
- 按风格取不同底色与文字色：`journal` 奶白 `#f7f3ea` / 墨色文字；`ink` 宣纸米 `#f2ece0` / 深墨文字
- 合成后仍是 PNG/JPEG，尺寸 1024×1632

### R2 文字不依赖运行时字体

生产镜像 `node:22-alpine` 没有中文字体，运行时用 SVG 渲染中文会出方框。

做法：品牌带（含文字）作为**预渲染 PNG 素材**提交到仓库，路径 `apps/server/assets/share-brand-{journal,ink}.png`（1024×96）。运行时只做「贴图 + 贴二维码」，不渲染任何文字。

素材由 `scripts/generate-share-brand-band.mts` 生成本地产出（在 Windows 上有中文字体），产物提交，脚本不进 CI。

### R3 二维码

- `qrcode` 纯 JS 生成 PNG buffer：72×72，白底，误差校正等级 M
- 内容：`https://sakiiko.com/?from=poster`（带来源参数便于后续统计）
- 生成失败（不应发生）时降级：只贴品牌带，不贴二维码，**不阻断海报生成**

### R4 开关与兼容

- 新增环境变量 `SHARE_BRAND_ENABLED`，默认 `true`；设为 `false` 时跳过合成，行为与现在一致
- 已有成品（旧图）不重生成：`trip_share_images` 存的是内容寻址文件名，prompt 未变仍会回显旧图。旧图没有品牌带属预期，不做迁移
- 索引表 `prompt_hash` 语义不变（仍按 prompt 判新旧），品牌带不参与 hash

## Acceptance Criteria

- [x] `npm run typecheck` 通过 — 2026-10-20 EXIT=0
- [x] `node --import tsx --test apps/server/src/__tests__/sharePosterBrand.test.ts` 通过（合成后尺寸、文字/二维码区域非纯色、等比缩放、JPEG 保格式、无法解析输入原样返回、链接常量）— 6/6 pass
- [x] `node --import tsx scripts/verify-trip-share-image.mts` 通过（临时库，模拟上游）— PASS，需 `SHARE_IMAGE_TEST_DATABASE_URL` 指向可用 PG（默认端口 18797 本机无服务）
- [x] `node apps/web/tests/trip-share-image-browser.mjs` 通过（前端契约不变）— PASS
- [x] 人工核对排版：1024×1680，底部 144px 品牌带，左「sakiiko.com + 织程 TripWeaver · AI 生成」，右 112px 二维码
- [x] `SHARE_BRAND_ENABLED=false` 时跳过合成（代码路径：`env.shareBrandEnabled` 为 false 则直接落盘原图）
- [x] Docker 兼容：`node:22-alpine` 容器内 `npm install sharp qrcode` + composite 实测输出 `200x240 1758B`

### 实跑记录

- 素材：`apps/server/assets/share-brand-{journal,ink}.png`，1024×144，约 9.7KB（脚本生成后可重复重建）
- 二维码内容 `https://sakiiko.com/?from=poster`，误差校正 M，白底安静区 12px（1024 宽时）
- 首次实现把品牌带定为 96px / QR 72px，实测在手机上缩到 26px 无法扫描，改为 144px / 112px
- 顺手修了 `trip-share-image-browser.mjs` 的两处早期漂移：① 通知轮询 15s→60s（10-18 SSE 上线后）后 `fastForward(15_100)` 不再触发请求，该段断言已移除并在注释里说明替代覆盖；② 「下载图片后标已读」原本靠后面的时间推进顺带等到，改为显式轮询等待 markRead 落地

### 环境变量覆盖

`SHARE_BRAND_ENABLED` 默认 `true`，属可选项：

| 环境 | 需要做什么 |
|---|---|
| 本地 `apps/server/.env` | 不用改（默认开启）；想关掉时加 `SHARE_BRAND_ENABLED=false` |
| `.env.example` | 已加注释掉的示例项 ✓ |
| 线上 `/opt/trip-weaver/.env` | 部署后自动开启；要关才需添加 |

## R5 生图失败原因透出（验收时发现的附带修复）

验收时用户看到的是「服务器内部错误」，实际是上游中转站返回 504（`err.message: 生图服务暂不可用（HTTP 504）`，`statusCode: 502`）。根因：全局 errorHandler 把所有 5xx 的 message 一律替换为通用文案，用户无法区分「上游挂了」「配额用完」与「代码炸了」。

修复：`imageError()` 生成的错误带 `expose: true` 标记，errorHandler 对带标记的 5xx 保留原 message；未带标记的 5xx 仍是「服务器内部错误」（不外泄堆栈与数据库报错）。验证：`apiResponse.test.ts` 新增 `/api/exposed` 用例；本次 502 实测对外消息已变为「生图服务暂不可用（HTTP 504）」。

## Out of Scope

- 二维码指向具体行程的公开页（需新增分享 token + 公开只读页 + 隐私设计，单独任务）
- 已生成旧图的批量重制
- OG 卡片 / 服务端分享页 HTML（依赖公开 URL，单独任务）
- 海报内文案、提示词的调整

## Technical Notes

- 依赖选择：`sharp`（多格式解码 + composite，alpine 用 `@img/sharp-linuxmusl-x64` 预编译包，npm 按平台自动挑）+ `qrcode`（纯 JS）
- 合成必须在 `store.save` 之前，这样下载、通知、`GET /:id/share-image` 三个出口拿到的都是带品牌版本，无需分别处理
- 内容寻址文件名由合成后的 bytes 计算，天然区分新旧图
