# 演示悠然小楷 / Youran Handwriting

选用日期：2026-09-30。作者字体名：演示悠然小楷 / slideyouran Regular。

原字体版权记录：Copyright © 2020 by keynoteart x mengxiangyuan x QiuyePPT. All rights reserved.

发布者原文：<https://mp.weixin.qq.com/s/Q1lAIre4yJ-Zlf2CD82EPA>

> 「演示悠然小楷」献给全社会永久免费使用，包括商用。

这是作者免费使用声明，不能标为 OFL 或项目的 MIT 授权。保留作者名称、原始版权记录与发布链接。TTF 的 OS/2 fsType 为 8（Editable embedding）。

本项目仅转换为 WOFF2 并按字符拆分以按需加载，保留全部有效 Unicode 字形映射，未重绘字形。转换后的内部字体族名为 `Youran Handwriting`，保留原始版权元数据。文件名带内容哈希，避免旧千图字体缓存混用。

取得的 TTF：wordshub/free-font 对作者字体的收录，下载地址：
<https://raw.githubusercontent.com/wordshub/free-font/master/assets/font/中文/其他字体/演示悠然小楷.ttf>

已核对源文件 SHA-256：`10a92c32d388f119db8a975fe6f0507ec48d15e3050e7ff2971c3784ad878580`。

重建（Python 需要 `fonttools[woff]`）：

```text
python scripts/build-handwriting-font.py --source <演示悠然小楷.ttf>
python scripts/generate-title-font-coverage.py
python scripts/generate-title-font-coverage.py --check
```

生成的字体 CSS 在 `apps/web/src/styles/tailwind.css`；服务端与前端共用 `packages/shared/src/handwriting.generated.ts` 的实际 cmap 数据，服务端分片校验清单在 `apps/server/src/generation/titleFont.generated.ts`。
