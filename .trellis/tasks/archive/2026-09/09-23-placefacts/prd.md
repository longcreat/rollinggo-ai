# 实体归一：placeFacts 名称规范化合并，修评分稀释

## 背景

实测北京 3 日：故宫博物院最终分 32.8，雍和宫 100。探针发现知识库里「故宫」（门票/闭馆证据挂在它下面）与「故宫博物院」（推荐分/提及挂这边）是两个独立条目，**实体分裂稀释了得分与情报**。Day1/Day3 分天由段内头牌分决定，头部分数失真直接影响编排顺序。

## 决策

- **本仓库加载时合并**（立即生效、可控）；上游 xhs-travel-pipeline 做实体归一是更根本的修法，作为后续建议提给上游，不阻塞本任务。
- 归一化规则：**去尾部机构后缀**（博物院/博物馆/公园/风景名胜区/风景区/景区/旅游区/陵/寺院…），不做任意子串合并——「沈阳故宫」不含任何尾部后缀差异，天然不与「故宫博物院」合并，无需额外防护。
- 合并规则：recommendScore 取 max（质量分不叠加）、mentionCount 求和（热度可叠加）、themes 并集、visitMinutes 取 max、坐标取有值行、source 优先 goldset、closureText 取先挖到的。
- 范围只动 `placeFacts.loadPlaceFacts`：由「按名精确查」改为「全城行拉回 → TS 侧归一合并 → 按归一键查」。城市行数百级，性能无感。retrieveContext / search_verified_places 的检索侧不在本次范围。

## 改动范围

1. `placeFacts.ts`：
   - `normalizePlaceKey(name)`：trim + 去尾部机构后缀（长后缀优先匹配）
   - `loadPlaceFacts`：拉全城行，按归一键分组合并（合并规则见上），返回 Map 的 key 为**候选传入名**（调用方无感）
   - 候选名归一后命中合并组 → 返回合并事实；组内无该原名也照给（如归一键「故宫」组服务候选「故宫博物院」）
2. 测试：
   - 归一键：故宫博物院/故宫 → 同键；沈阳故宫 → 不同键；景山公园/景山 → 同键
   - 合并：分数取 max、提及求和、themes 并集、source 优先 goldset
   - loadPlaceFacts 集成（mock pool 或直接打本地库）：候选「故宫博物院」拿到合并后分数

## 不做（Out of Scope）

- 上游管道的实体归一（另提需求）
- retrieveContext / search_verified_places 检索侧的实体合并
- research_evidence 的 place_id 重挂（合并发生在读取侧，不动数据）

## 验收

- 归一与合并单测全过；故宫博物院合并后得分显著回升（mentionCount = 两边之和）
- 全套测试 + typecheck 绿
