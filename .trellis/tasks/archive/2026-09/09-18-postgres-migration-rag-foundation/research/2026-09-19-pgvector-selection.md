# pgvector 向量检索选型记录

- 任务：`09-18-postgres-migration-rag-foundation`
- 日期：2026-09-19
- 决策人：aimer + Claude
- 状态：已实施

## 决策

RAG 向量与业务数据同库存于 PostgreSQL（pgvector 扩展），**不引入** Qdrant / Milvus / Pinecone 等独立向量数据库。

详细理由与降级链已写入 `docs/TECHNICAL_ARCHITECTURE.md` §4.3，本节为任务存档。

## 关键事实

- 向量是 `canonical_places` / `research_evidence` 的**派生列**（`vector(1024)` 可空），与原文同事务写入，无双写一致性问题。
- 混合查询（向量余弦距离 + `verified` / `city` / `kind` SQL 谓词）单条 SQL 完成，这是 pgvector 相对独立向量库的核心优势。
- 数据量 <1000 行时不建 ivfflat/hnsw 索引（顺序扫描足够），数据破百万或 QPS 过百时再评估迁移。
- 部署侧 compose 镜像由 `postgres:16` 换为 `pgvector/pgvector:pg16`，零新增服务。
- 降级链：扩展不可用 → 纯关键词召回；EMBEDDING_* 未配 → 跳过向量层；HTTP 失败 → 单批置 null。全程不抛错。

## 触发重评估的条件

- `canonical_places` + `research_evidence` 总行数 > 100 万
- 检索 QPS > 100
- 需要复杂 ANN 参数调优（ef_search / m 等）
