# 摄影流水线实施设计

## 已核实接口

- 上游 `app/web/api.py` 地点列表按 `PlaceSummary.recommend_score DESC, CanonicalPlace.id ASC` 排序。复用 `app/vision/eligibility.py:export_conditions`。
- `scripts/collect_photography.py` 当前写 raw_note；新流水线不调用该脚本、不调用 save_crawl_result。
- `VisionClient.analyze_image` 支持指定 system_prompt；原图可经 image_to_data_url 转为本地 JPEG 输入。不复用攻略 OCR 提示词。
- `app/web/jobs.py` 为声明式作业表，前端自动渲染字段，但需同步 JobsPage 的 PIPELINE_ORDER。
- 旧 `scripts/export_place_images.py` 仍按笔记热度排序，使用序号文件名。摄影导出需按正式选择顺序，使用内容哈希文件名以保留历史行程图片。

## 数据流与状态

只读地点排名 → runs/<run_id>/snapshot.json → 搜索/笔记详情缓存 → 原图内容哈希缓存 → 身份及质量模型审核 → candidates.json → selected.json → 导出 manifest/media → tripweaver 导入现有图库。

独立数据目录为 data/photography/<城市哈希>。城市锁保护跨 CLI/Web 并发；原子写清单。原始图片索引、来源笔记/作者、审核方法、模型及提示词版本随候选保存。模型不确定不入选。

默认补缺保持所有已选图片；提升质量可增加备选但保持封面；显式刷新允许重选。续跑指定 run_id，使用原排名/参数；新轮次可复用下载与模型缓存。缓存键包含内容哈希、目标身份和模型/审核版本。

## 实施顺序

1. 独立存储、参数、排名快照、预算、自动审核和选择的核心与离线测试。
2. CLI/Web 独立入口、全链路可选阶段、精选导出和下游契约。
3. 安装前逐文件哈希检查；完成离线测试后请求沙箱允许写入上游仓库。
4. 北京 5 景点有界试点与可视化报告，统计质量、身份、覆盖、重复及缓存。用户验收后才能提交和归档。

## 边界

不修改历史行程；不扩大为其他图库供应商重构；不自动迁移旧 raw_note 摄影数据。摄影失败保留攻略结果并明确记录失败/部分完成，不能返回伪成功。
