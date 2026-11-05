最新结果见 [delivery-report.md](delivery-report.md)。以下保留首批优化的历史记录，其中数量与待办已被最新报告更新。

# 上游配图优化实施记录

2026-09-29。目标仍在推进；本记录不是用户验收，不提交、不归档。

## 已落地到上游原仓库

1. app/vision/assignment.py、scripts/review_place_images.py：同笔记有效地点候选、图片哈希、候选包 HTML、预算限制的真实视觉建议、复核后事务绑定。
2. 真实 API 发现 ID 与名称错位、攻略拼图误收问题，增加 image-assignment-v2：place_id 与 place_name 双校验，image_kind 与 cover_usable 独立判断，保留模型原始输出。
3. note_image.assignment JSONB 已迁移，保存原图哈希、版本、候选 ID、判断依据、复核来源与时间。区分 human-reviewed / agent-reviewed，不将模型建议冒充人工确认。
4. app/vision/sampling.py：在每篇原预算内保留前部并覆盖中后部，去重但不重新编号。pipeline、CLI --sampling、Web 作业表单均已接入；head 保留原取样方式。
5. app/vision/eligibility.py：地点与图片导出共用有效城市、active、双坐标、质量条件，均需 summary。坏图不占导出配额，无结果写空清单。地点导出补 --city 参数。
6. 缺图地点关键词清单 photo_deficits 随候选包输出；尚未自动执行定向补采。

原文件已备份到 research/upstream-before（本地忽略），安装脚本验证基线哈希，未覆盖原仓库无关改动。

## 真实调用与数据变更

- 第一批 10 张真实视觉调用：暴露拼图与 ID 错位；没有将此批建议直接绑定。
- 修正后第二批 10 张：7 PENDING、1 REJECTED、2 UNKNOWN。这不是 70% 准确率；PENDING 仅为待核验建议。
- Codex 实际打开图片 385，看到金色匾额“香积寺”，确认是单张实拍；按 agent-reviewed 绑定 canonical_place 4125。其余仅凭通用老街/运河特征的建议未批准。
- 该样本完成 prepare → propose → 复核 → apply 预览 → apply → WebP 导出 → tripweaver 导入 → HTTP 验证。
- 杭州消费端有本地图地点从 33 增至 34；标准 manifest 34 条，孤儿条目 0，缺失文件 0。旧清单中的梦溪苑已被有效地点条件排除。
- 标准清单备份：data/backups/image-optimization/xhs-place-images-杭州-before.json。
- 香积寺图片经 127.0.0.1:5173 和 :8787 返回 HTTP 200、image/webp、102698 字节。
- 原三日游不包含香积寺，因此这次新增地点封面不会改变旧行程快照；旧行程仍为 4 个有图候选，其中 2 个本地图。

## 验证

- 已安装原仓库：159 tests passed，2 deselected。排除既有过期 test_city_bounds 与真实天地图 test_live_resolve_hangzhou，不能宣称全部测试通过。
- 专用随机临时 PostgreSQL 数据库验证通过：迁移幂等、真实候选查询、审核预览回滚、写入、重复幂等、停用拒绝、真实导出、空清单刷新。测试库已清理，未写业务测试记录。
- 前一轮 compileall 通过；后续脚本已通过真实运行和导入验证。
- 当前新审核字段已迁移，无需再次确认授权；用户已授权后续低风险操作与真实 API 调用。

## 尚未完成，下一步继续

1. 扩大明确景点证据的图片复核，并增加与原三日游缺口直接相关的候选。当前只新增一个确认地点，远未达到覆盖目标。
2. 自动识别流水线仍需更强的证据门槛和可测准确率；第二批模型仍会把通用街景当作具体地点，不能直接放开自动绑定。
3. 当前 spread 是固定预算跨位置取样，还不是按目标配额动态停止的自适应取样，也没有完整本地下载缓存复用。
4. OCR 地点证据增量回流、版本化去重、重新提取后的归属失效处理尚未实现。
5. 照片采集用途分离、缺图驱动关键词实际执行、CLI/Web/PowerShell 全链路阶段统一尚未实现。
6. 空 manifest 不会主动撤回消费端旧封面；下线/撤回、别名合并关联迁移、gallery 契约仍需独立实现。
7. Web 当前只接入 sampling 参数，候选复核仍是 CLI + HTML/JSON 工作流，尚无 Web 审核表单。

详细原始产物均位于本目录，本地忽略原文候选包/内嵌图片 HTML。最后两批视觉进程已正常结束，无待轮询进程。

