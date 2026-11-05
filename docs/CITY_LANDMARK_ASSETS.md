# 城市地标素材：免费 SVG 与 AI 线稿

建议先用 **IconPark** 选一组同风格线稿；想更接近原 UI 图里的手绘建筑，再去 Iconfont 搜索中文地标。下载后存成本地静态文件，不让用户打开行程时请求第三方图库。

也支持用户自行生成的透明 PNG/WebP，当前北京封面使用用户提供的 AI 天坛线稿。AI 生成平台可能收费，下面列出的免费图库是另一种素材来源。

## 网站与免费条件

| 来源 | 用途 | 免费条件与本次核实情况 |
| --- | --- | --- |
| [IconPark](https://iconpark.bytedance.com/official) | 首选统一线性风格。有东方明珠、长城、中式亭子、熊猫、山景，可调整线宽、导出 SVG。 | 已核实官方仓库、下载说明及 [Apache 2.0 授权](https://github.com/bytedance/IconPark/blob/master/LICENSE)。免费使用，分发时保留许可证与相关版权/NOTICE 信息，修改时按许可证标注。 |
| [Iconfont 阿里巴巴矢量图标库](https://www.iconfont.cn/) | 中文城市/建筑关键词的查找入口，适合挑选更细的手绘或线描系列。 | 本次首页可访问，具体图标库为动态页面，未核实单个作品授权。只选明确可免费使用的素材，以作者/图标库说明为准，不把全站视作统一免费商用授权。 |
| [UXWing](https://uxwing.com/) | 建筑、动物、山景等通用线稿的补充来源，具体中国城市覆盖未核实。 | 已核实[授权页](https://uxwing.com/license/)：可用于个人、商业和客户项目，不要求署名。不可把素材作为图标库重新打包分发或销售；用于产品界面符合其允许用途。 |
| [SVG Repo](https://www.svgrepo.com/) | 备选检索入口，搜索 `beijing`、`shanghai`、`panda`、`pagoda`，优先 outline/line 系列。 | 本次访问被站点验证页拦截，未核实具体作品及最新下载条件。只选详情页明确免费的 SVG，并检查单项 License；不保证全站均免署名。 |

没有纳入需付费才能取得目标 SVG 的方案，也未把第三方图标下载到应用目录。

## IconPark 可定位的素材

以下文件均已在官方仓库目录中核实。链接用于定位图标；**原始 source SVG 部分为多色模板，请优先在官网选择「线性 / Outline」再导出**，不要直接将彩色模板当作线稿。

| 城市 | 建议元素与检索词 | 官方素材定位 |
| --- | --- | --- |
| 北京 | 长城 `great-wall`；宫殿 `palace`。如要复刻原图的天坛，应另搜“天坛 线稿”。 | [长城](https://github.com/bytedance/IconPark/blob/master/source/Build/great-wall.svg)、[宫殿](https://github.com/bytedance/IconPark/blob/master/source/Build/palace.svg) |
| 杭州 | 中式亭子 `chinese-pavilion`，作为西湖意象；不是某一真实亭子的精确绘图。 | [中式亭子](https://github.com/bytedance/IconPark/blob/master/source/Build/chinese-pavilion.svg) |
| 成都 | 熊猫 `panda` | [熊猫](https://github.com/bytedance/IconPark/blob/master/source/Animals/panda.svg) |
| 上海 | 东方明珠 `pearl-of-the-orient` | [东方明珠](https://github.com/bytedance/IconPark/blob/master/source/Build/pearl-of-the-orient.svg) |
| 大理 | 山景 `mountain` / `landscape`，作为苍山洱海意象；不是精确地标。 | [山](https://github.com/bytedance/IconPark/blob/master/source/Travel/mountain.svg)、[山景](https://github.com/bytedance/IconPark/blob/master/source/Travel/landscape.svg) |

IconPark 是规则化线性图标，复杂度低于原图的手绘插画。若更看重原图质感，在 Iconfont 搜索“城市地标 线稿”“天坛”“西湖 亭子”“东方明珠”“熊猫 线性”“苍山 洱海”，并优先选择同一个作者/系列。

## 保存到项目

目录：`apps/web/src/assets/city-landmarks/`

1. 使用透明背景的单色线稿：SVG 应有 `viewBox`；PNG/WebP 应有真实透明通道。AI 白底图需先去底，灰白棋盘格不能充当透明背景。IconPark 建议选 Outline，先尝试线宽 1–2，再按视觉效果调整。避免大面积背景矩形和过多留白。
2. 按目的地名保存，例如 `北京.png`、`杭州.svg`、`成都.webp`。支持小写扩展名，同名素材优先顺序是 SVG → PNG → WebP。
3. 在同目录 `SOURCES.md` 记录来源、作者、授权与下载日期。使用 IconPark 时附上其许可证；需页面署名的素材也应按作者要求署名。
4. 开发模式刷新页面即可识别；正式部署前重新运行 `npm run build -w apps/web`。

页面会把线条染成对应封面的颜色。`北京市` 可以匹配 `北京.png`；`北京、天津` 不会猜测用北京图。没有对应文件或文件损坏时，保留居中的城市文字。当前已有北京天坛 PNG；浏览器回归中的房屋是临时测试图形。

## 检索证据

核实日期：2026-09-29。`smart-search doctor --format json` / `smart-search search ...` 返回主搜索鉴权错误（HTTP 401），`smart-search fetch` 提取为空；随后通过公开网站与官方 GitHub 仓库直接读取核实。

可复现的关键命令：

```powershell
smart-search doctor --format json
smart-search search '免费 城市地标 线稿 SVG 下载 北京 天坛 上海 东方明珠 iconfont SVG Repo 免费授权' --extra-sources 5 --timeout 60 --format json
Invoke-WebRequest -Uri 'https://api.github.com/repos/bytedance/IconPark/git/trees/master?recursive=1' -UseBasicParsing
Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/bytedance/IconPark/master/README.md' -UseBasicParsing
Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/bytedance/IconPark/master/LICENSE' -UseBasicParsing
Invoke-WebRequest -Uri 'https://uxwing.com/license/' -UseBasicParsing
```
