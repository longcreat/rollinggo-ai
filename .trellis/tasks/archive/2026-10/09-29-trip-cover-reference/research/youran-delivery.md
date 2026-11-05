# 悠然小楷应用结果（2026-09-30，待用户验收）

用户选择 E 后，将原千图手写位置统一切换为 `Youran Handwriting`：行程封面/列表装饰文案、详情页每天与概览标题、生成页进行中提示、照片题字及 new 标记。未改正文与宋体主标题。

## 字体与覆盖

- 从已核验源 TTF 转换，保留全部 6955 个有效 Unicode 映射（6766 个基本区＋扩展 A 汉字）。27 个本地 WOFF2 分片共 5,783,404 字节；常用字片 256,716 字节，其余按需加载。
- 文件名带内容哈希，清除旧千图引用及7个旧分片，移除已无使用位置的 npm 依赖；原作者版权、免费商用声明、出处、SHA-256和重建命令保存在 `apps/web/public/fonts/handwriting/NOTICE.md`。
- `build-handwriting-font.py` 逐片核对 cmap，保证源文件全部有效字符都部署；`generate-title-font-coverage.py` 同时生成 shared 字库数据和服务端分片 hash 清单，防止浏览器与生成校验使用不同版本。
- 动态文字若有未收录的字母/汉字/数字，整段使用备用宋体。普通标点、空白与 emoji 允许自然回退，避免进度文案的省略号使整句失去手写风格。真实地名与历史标题不改写。

## 验证

- 根目录 `npm run typecheck` 通过。
- `npm run build -w apps/web` 通过；保留原有大 chunk 提示。
- 字体覆盖/标题写入/显示回退共5项测试通过；单一样式入口检查通过。
- `python scripts/generate-title-font-coverage.py --check` 通过。
- `handwriting-browser.mjs` 的9个实际字体检查通过，包含详情/概览/手机/封面/相片题字和“罍”整段回退；没有行程写入，没有旧字体 URL 请求。
- `generation-browser.mjs` 的桌面、笔记本、手机、长标题、空候选5种布局通过。
- `trip-collection-browser.mjs` 的布局、筛选、中文输入、导航、缺图等原有回归通过。
- 本地 Vite 曾缓存新生成文件创建前的解析失败；触发开发服务重启后恢复。类型检查与生产构建不受影响。此类生成资源应先生成再接入 import，避免误诊成运行时代码错误。

## 可验收结果

- 应用入口：<http://127.0.0.1:5173/trips/32c3abae-eb1e-4587-8832-5531b2169385>。
- `youran-verification/editor-desktop.png` / `editor-mobile.png` 使用只读查询获取的现有北京行程数据，实际应用组件和本地照片；鉴权/对话使用测试夹具，地图底图未作为验收内容。
- `youran-verification/result.json` 证明“中轴宫苑漫步”6字均为 Youran-Handwriting 自定义字体。
- 行程列表回归证据在 `youran-verification/collection-regression/`。
- 未提交、未归档、未标记任务完成；用户选字体仅授权实现，最终效果仍待验收。
