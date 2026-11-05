# 图源策略与全链路调整 · 2026-10-01

状态：已实现、安装并自测，等待用户验收；任务仍为 `in_progress`，未提交、未归档。

## 可验收入口

- 上游控制台：http://127.0.0.1:18842/#pipeline
- 原图源对比：http://127.0.0.1:18843/
- 全链路截图：`verification/upstream-run-all.png`；独立摄影截图：`verification/upstream-entry.png`。
- 浏览器证据：`verification/upstream-browser.json`。没有触发真实采集或导入。

## 最终行为

新生成行程优先使用审核过的精选图库，其次复用同景点已保存的外部选择（Pexels → Pixabay → Unsplash → Commons）。没有外部选择时，新检索顺序为 **Pexels → Pixabay → Unsplash → Commons → 小红书独立图库/旧封面 → 高德**。保留已有持久选择、最多三图和署名规则；Unsplash 仅在实际采用时报告下载事件。历史行程仍读取保存的图片快照。

全链路页面仅显示关键词与「含攻略图文字提取」选项。文字步骤强制 `save_scenery=False`，只抽攻略卡片、地图、拼图的信息，不保存风景图片或新增景点配图关联。收到旧 `with_photography=True` 或 `save_scenery=True` 参数也不能启用摄影或风景保存。其余攻略步骤保持原顺序。

独立「排行景点摄影」Web / CLI 继续提供默认 TOP20、指定景点、补缺/提升/刷新模式、预算与续跑。CLI `run-all --with-photography` 已移除。旧统一图片提取入口默认行为兼容，新增 `--no-save-scenery` 可只抽文字；只抽文字会记录处理标记，之后用旧脚本补存风景需显式 `--scope all` 或 `--scope notes`，独立排行摄影不受该标记影响。

对比页的 24 张推荐尚未写入正式精选清单；本轮落实来源顺序，不把样片比较自动视作用户逐图选择。小红书基线仍为 TOP20 中五景点定向试点的 8 张，未运行完整 TOP20。

## 其他类似来源

| 来源 | 官方资料核对 | 本轮决定 |
| --- | --- | --- |
| [StockSnap](https://stocksnap.io/license) | 提供 CC0 图片 | 可作为后续补充，未验证景点覆盖及自动接入效果 |
| [Openverse](https://openverse.org/about) | 聚合开放许可作品，[提供 API](https://docs.openverse.org/api/)，逐作品核实许可 | 可拓展检索范围，本轮不新增适配器 |
| [Flickr](https://www.flickr.com/services/api/) | 有 API，商业使用需事先安排 | 本轮不接入 |

使用 smart-search-cli 抓取官方页面，证据为 `alternative-*.json`。搜索模型返回 `model_not_found`，本轮以成功获取的官方页面为依据，没有把候选来源表述为已经完成质量对比。

## 验证与安装

- 上游暂存版本：排行摄影、视觉提取、Web 任务及导出共 **76 项通过**。混合风景/文字用例验证关闭风景保存后 OCR 仍执行、风景文件和配图记录均为零；独立旧模式保持兼容。Python 语法编译通过。
- 下游：图片导入、图库、封面查询和精选图的隔离数据库测试 **36 项通过**；stockPhotos / curatedPhotos 相关测试 **17 项通过**（两组有重叠，不相加）。覆盖新的来源顺序、缓存优先、小红书三图及署名回退。
- `npm run typecheck` 通过；相关改动 `git diff --check` 通过。没有前端源码改动，页面字段来自后端 JobSpec，不需要重建前端 bundle。
- 安装脚本逐文件核对基线/上次安装哈希，安装 8 个文件，保留备份；再次检查显示待安装 0 个文件。没有覆盖其他任务的修改。
- 已安装版本在 18842 启动。真实浏览器确认全链路仅有 `keywords` / `with_images`，文字开关可操作；独立摄影默认 TOP20、目标和模式可编辑；历史独立摄影审核页 31 图成功解码、页面异常 0、写请求 0。任务结果展示使用一个已完成记录的浏览器 fixture，审核页和入口配置来自真实服务。

复验命令：

```powershell
# cwd 为 research/upstream-stage；使用工作区内的短临时路径，避免 Windows 路径过长
& 'D:/Project/xhs-travel-pipeline/.venv/Scripts/python.exe' -X utf8 -m pytest tests/test_ranked_photography.py tests/test_vision_pipeline.py tests/test_web_tasks.py tests/test_image_export.py -q -p no:cacheprovider --basetemp D:/Project/tripweaver/data/qa-photo-policy-1001-01

# cwd 为 tripweaver；测试脚本创建并清理专用随机库，不改应用数据
node .trellis/tasks/09-30-ranked-place-photography/research/verify_downstream.mjs
node .trellis/tasks/09-30-ranked-place-photography/research/upstream_browser_check.mjs
npm run typecheck
```
