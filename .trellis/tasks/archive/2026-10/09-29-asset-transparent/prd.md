# 批量去除地标 PNG 白底

## Goal

`apps/web/src/assets/city-landmarks/` 下的城市地标线稿需要是透明 PNG，`TripCover.tsx` 直接叠加在卡片底色上使用。目前靠人工用第三方工具逐张去白底（本次 `北京.png` 就是手工处理的）。本任务提供一个仓库内的零依赖脚本，把该目录下所有白底不透明 PNG 一键转为透明，并加到 npm script 入口。

## Requirements

1. 新增 `scripts/to-transparent.mjs`，纯 Node 内置模块（`node:fs` / `node:path` / `node:zlib`），不新增任何依赖。
2. 用法：`node scripts/to-transparent.mjs [dir]`，`dir` 省略时默认 `apps/web/src/assets/city-landmarks`。
3. 扫描 `dir` 下**一层**（不递归子树）所有小写 `.png`；跳过 `README.md` 等非图片。
4. 转换算法（只做「白色全透明」）：
   - 逐像素取 `L = max(R, G, B)`
   - 输出 `alpha = 255 - L`，`R = G = B = 0`
   - 抗锯齿边缘自然得到半透明 alpha，不额外做阈值处理
5. 支持输入 PNG：8 位色深、颜色类型 2（真彩 RGB）或 6（真彩+Alpha）、非隔行（interlace=0）。
6. 输入是 16 位 / 调色板 / 灰度 / 隔行 / 非 PNG 时：打印明确错误，**不写文件**，整体退出码非 0，其余文件继续处理。
7. 幂等保护：输入已是 8 位 RGBA 且**存在任意 alpha < 255** 的像素 → 判定为「已是透明图」，跳过并打印提示，原文件字节不变。
8. 原地覆盖原文件（不生成 `.bak`、不输出新文件）。写入前先完整转换到内存，成功后才 `writeFileSync`，避免半成品落盘。
9. 输出统一为 32bpp RGBA PNG，保留原尺寸。
10. 运行结束打印汇总：处理 N 张 / 跳过 M 张 / 失败 K 张，逐文件一行结果。
11. `package.json` 增加 root script：`"assets:transparent": "node scripts/to-transparent.mjs"`。

## Acceptance Criteria

- [ ] `npm run assets:transparent`（不带参数）在真实目录上运行，`北京.png` 被判定为已透明并**跳过**，`git status` 中该文件无变化。
- [ ] 对一张白底不透明测试 PNG 运行 → 输出 RGBA，白色背景像素 `alpha === 0`，纯黑线条像素 `alpha === 255`，灰阶抗锯齿像素 `alpha === 255 - L`。
- [ ] 连续对同一张白底图运行两次：第二次被幂等保护跳过，文件字节与第一次输出完全一致。
- [ ] 传入 16 位色深或隔行扫描的 PNG → 报错含文件名与原因，退出码非 0，原文件未被修改。
- [ ] 目录不存在 / 无权限 → 报错清晰，退出码非 0。
- [ ] 输出信息含每张图的相对路径与结果（处理 / 跳过 / 失败）。
- [ ] `node --check scripts/to-transparent.mjs` 通过；根 `npm run typecheck` 不受影响（`scripts/` 不在 tsconfig 范围）。
- [ ] 处理后的 PNG 在 `pnpm/npm run dev` 的行程卡片上叠加正常（人工目视一次）。

## Definition of Done

- 脚本零依赖，遵循仓库现有 `scripts/*.mjs` 的写法（ESM、`node:` 前缀、无外部包）。
- 幂等与失败保护到位：不会把已透明的图二次处理成黑块，不会留下半成品文件。
- `apps/web/src/assets/city-landmarks/README.md` 补充脚本用法一行说明。
- lint / typecheck 绿。

## Technical Approach

- **PNG 解码**：读文件 → 校验 8 字节签名 → 解析 `IHDR` → 拼接所有 `IDAT` → `zlib.inflateSync` → 按每行 filter type（0-4）逐行反滤波，得到连续像素缓冲。
- **PNG 编码**：每行前置 filter byte 0（None），`zlib.deflateSync` 压缩，按 `IHDR / IDAT / IEND` 写块，CRC32 用本地查表实现（约 15 行）。
- **像素变换**：RGB 输入按 `stride = width*3` 读，RGBA 按 `width*4` 读；统一写 RGBA 输出。
- **幂等判定**：解码时记录是否出现过 `alpha < 255`；命中即跳过。
- 代码分块：`decodePng` / `encodePng` / `toTransparent` / `walkDir` / `main`，单文件内函数级拆分，不做抽象层。

## Decision (ADR-lite)

**Context**：需要仓库内可复现的批量去白底能力，本机无 ImageMagick，仓库无任何图片处理依赖（无 sharp / pngjs / jimp）。候选方案：纯 Node 手写 PNG 编解码 / 引入 sharp / 用 PowerShell 复用本次验证过的 GDI+ 代码。本次 `北京.png` 的处理已用 PowerShell + `System.Drawing` 跑通（lines 版），但 PowerShell 与仓库 `scripts/` 下清一色 Node ESM 脚本风格不一致。

**Decision**：纯 Node 零依赖 `.mjs`，内置 `zlib` 手写 PNG 编解码；原地覆盖；仅实现「白色全透明」模式；接入 `npm run assets:transparent`。

**Consequences**：
- 收益：不引入原生二进制依赖，Windows / macOS / CI 一致，与 `scripts/verify-*.mjs` 风格统一。
- 代价：只支持 8 位 RGB/RGBA 非隔行 PNG，其余格式直接报错（地标素材均满足）；约 150 行自研编解码需要一次正确性验证。
- 未采用 `cutout`（保留封闭区域白色）模式。当前地标素材是纯线条稿，线条内部封闭白色也应透明；若将来需要白底实体建筑叠加在深色背景上，再补 `--keep-interior` 泛洪模式。

## Out of Scope

- `.webp` / `.svg` / JPEG（`README.md` 已说明优先用 SVG，本脚本只处理 PNG）。
- `cutout` 模式（保留建筑内部白色）与 `--keep-interior` 开关。
- 批量重命名、压缩体积、生成多倍图。
- 递归处理子目录。
- 反白（深色背景浅色线条）与彩色素材。

## Technical Notes

- 目标目录约定：`apps/web/src/assets/city-landmarks/README.md`（文件名用城市中文名，支持 `.svg` / `.png` / `.webp`，不读子目录）。
- 读取方：`apps/web/src/components/TripCover.tsx` 用 `import.meta.glob` 按城市名匹配，优先级 SVG > PNG > WebP。
- 当前目录仅 `北京.png` 一张，1024×1024 `Format32bppArgb`，已是 lines 版透明图 —— 它就是幂等跳过的天然测试样本。
- 现有 `scripts/` 全部为无依赖 ESM 脚本（`verify-*.mjs` / `smoke-*.mjs`），root `package.json` 的 scripts 未接入它们，本次新增 `assets:transparent` 是该目录第一个 npm 入口。
- 根 `tsconfig` 只检查 `packages/shared`、`apps/server`、`apps/web`、`eval`，`scripts/*.mjs` 不参与 typecheck。
- 参考实现（本次手工跑通，PowerShell + GDI+）：`alpha = 255 - max(R,G,B)`，RGB 置 0；泛洪版 `cutout` 耗时约 59 秒 / 1024²，不纳入本任务。

## 2026-10-02 归档核对

用户本轮授权提交当前任务，并检查归档其他已落地任务。零依赖透明化脚本、npm入口和规范已提交；本轮只补任务归档，不处理或重写新增城市素材。

工作提交：`9edac21`、`98b3a4f`。本轮关闭脚本自动提交，手动以中文信息归档。
