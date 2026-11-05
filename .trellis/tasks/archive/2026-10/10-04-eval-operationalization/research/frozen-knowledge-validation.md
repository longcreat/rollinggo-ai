# 真实知识库冻结副本交付验证（2026-10-04）

状态：实现及 AI 自测完成，等待用户验收；任务仍为 in_progress，未提交、未归档，未接纳实际评估基线。

## 用户范围

用户「补第二种」：在固定金集地点之外，补充真实知识库冻结副本。只读导出当前知识表，验证隔离恢复，不调用真实模型或地图。

## 已生成的真实副本

- 目录：`eval/knowledge-snapshots/kb-2026-10-04/`
- 导出时间：`2026-10-04T12:10:05.571Z`
- 内容 SHA-256：`ba4a2d6c91365d7f417ce90cd2a657d40cb817dee86b7d65759599393492c2e1`
- 压缩文件：53,332,216 字节。
- 地点 4,841；证据 6,882；关系 270。
- 地点向量 4,841；证据向量 6,882；均为 1024 维，源配置记录 `cf/bge-m3`。
- 覆盖上海、云南、北京、厦门、广州、成都、杭州、苏州、西安、重庆、青岛，共 11 个地区。
- 苏州/西安/青岛在源知识库中仍只有金集地点，且无研究证据；导出忠实保留这个缺口。
- 只读取 public.canonical_places、research_evidence、place_relation 与必要 catalog；源连接未迁移、未写入，账号/会话/私人行程不在导出范围。

## 实现与使用

- `eval:knowledge:export`：原生 pg 客户端，以一致性只读事务导出；默认全地区，可按城市筛选。payload 字段白名单、原始 ID/引用/状态/向量、版本 hash 与覆盖摘要随副本保留。
- `--knowledge frozen --knowledge-snapshot <目录>`：校验内容与评估城市后导入随机空评估库，禁止混入旧知识；三表导入原子完成。
- `--skip-vectors`：仅显式设置时丢弃入库向量并关闭 live 查询 embedding，记录不同有效 hash；默认缺少同维度 pgvector 时失败。
- 每次 frozen 运行保留压缩副本及摘要，基线接纳重新检查原始与有效 hash，并复制知识文件；缺失/替换后不能接纳。
- `eval:knowledge:verify`：隔离导入并重导出，逐表内容 hash 比较、每城真实检索和向量查询；结束后清理所拥有的评估库。
- Git 忽略本地副本，CI 使用合成数据自测。当前远端手动 live 工作流保留 golden/empty；frozen 从本地 CLI 运行。
- 使用说明：`eval/README.md`；执行规范：`.trellis/spec/server/backend/evaluation.md`。

## 自测结果与证据

- `npm run eval:test`：29/29 通过。包括压缩往返、禁止覆盖、篡改/私有字段/引用/维度/时间戳校验、城市范围、去向量 hash，以及冻结基线缺文件/不匹配拒绝和完整/去向量条件保存。
- `npm run typecheck`：shared/server/web/eval 全部通过。
- `npm run eval`：9/9 PASS，hard=0、soft=54。报告：`eval/runs/2026-10-04T12-29-27-395Z-d3a4d130/report.md`。
- 首次最终离线回归保存报告遭 Windows EPERM（rename），该运行保留为失败记录；经沙箱外重跑成功，没有修改检查门槛。
- 全量真实副本往返通过：`eval/runs/verify-knowledge-1791116080195/verification.json`。三表内容 hash 一致，11 个地区均可检索，向量距离查询成功，隔离库已清理。
- 合成源自测通过：`eval/runs/verify-knowledge-1791116571617/verification.json`。验证私有哨兵排除、按城导出、稳定 hash、未验证/重定向保留、悬空证据排除、非空目标拒绝，以及缺向量列时无写入拒绝/显式跳过。
- 真实冻结输入 + 本机模型/地图 mock 通过：`eval/runs/verify-live-1791116484093/2026-10-04T12-21-26-020Z-d40cb62c/report.md`。4 个候选、完整阶段耗时与用量；连接只涉及管理库/所拥有的评估库，结束后清理成功。
- 两个工作流 YAML 解析通过，定向 `git diff --check` 通过，历史 `eval/snapshots` 未修改。未运行远端 GitHub Actions。

## 验收边界

上述结果证明冻结、恢复、检索与评估采集链路可用。评估请求仍为 smoke 3 例/full 9 例；本轮未新增语义标注集，也未产生真实模型质量结论。

本机 PostgreSQL 已支持该副本所需向量维度；配置好本机 `EVAL_PG_ADMIN_URL` 及模型/地图凭据后可运行：

```powershell
npm run eval:live -- --knowledge frozen --knowledge-snapshot eval/knowledge-snapshots/kb-2026-10-04 --suite smoke
```
