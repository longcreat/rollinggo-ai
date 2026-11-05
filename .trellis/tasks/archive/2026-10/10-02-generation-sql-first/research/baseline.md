# 优化前证据（2026-10-02）

- 历史 09-25 完整生成：research 4–7 轮、89–180s；plan 零模型、2.8–4.3s；review 3 轮、24–28s；总中位数约195s。仅历史参考，不当作当前实测。
- 当前数据库只读探针：SELECT 1 首次55ms、后续1–2ms。
- 北京「故宫 天坛 历史人文」：关键词10ms / embedding1239ms / vector SQL94ms / evidence9ms / 总1352ms；关键词8条，向量最终贡献0条；结果全为天坛及入口机位。
- 杭州「适合带老人轻松散步且不拥挤」：关键词3ms / embedding656ms / vector SQL239ms / evidence4ms / 总901ms；向量补8条，但多数购物条目，不能当作满足语义条件的证据。
- verified：北京1349、广州714、杭州670、厦门667、重庆618、成都411、青岛21、上海13、西安9、苏州9。仅北京652、重庆460条有非空themes。
- evidence共6399条、覆盖4128个place_id；缺place_id索引。
- 当前关键词满8条仍调用embedding后截断；embedding单批结束仍sleep300ms，最多3次30秒尝试。
- 标题初始prompt已有draft，却固定get_draft→update_titles→submit_review。
- add_candidate串行用于去重安全，逐条再查XHS；应复用已检索证据，不直接取消串行去重。
- 计时脚本把并行phase相加，且用phase减tool近似模型等待；需记录请求结束时刻与阶段区间并集。

## 决策

选择有界候选SQL+代码排序/归并，而非任意NL2SQL或完全关闭向量。已有normalizePlaceKey和类别映射优先复用；主题偏好需结合标签与类别，不把无标签当无匹配。硬条件与语义相似区别保留。
