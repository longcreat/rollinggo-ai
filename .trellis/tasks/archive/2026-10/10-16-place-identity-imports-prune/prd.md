# 线上库 place_identity_imports 快照表瘦身

**Task**: `10-16-place-identity-imports-prune`
**状态**: 已完成

## 1. 前提纠正（实测推翻了原始判断）

原始诉求是「线上库 `place_identity_imports` 300 行占 2.6GB」。实测两边数据：

| | 库总大小 | `place_identity_imports` |
| --- | --- | --- |
| **线上库**（VPS `154.44.20.217` / 容器 `trip-weaver-db-1`） | 78 MB | **0 行** |
| **本机 WSL**（容器 `tripweaver-pg`） | 2791 MB | **2636 MB（占该库 94%）** |

**线上库没有可清理的内容。** 2.6GB 全在本机 WSL 开发库。原判断把两侧混为一谈。

## 2. 目标表构成（本机 dev 库实测）

- 300 行，创建时间 2026-10-06 ~ 2026-10-12（今天是 10-16）
- **111 行 payload > 10MB**，最大 27MB，平均 8.6MB
- 14 行已回滚（payload 仅 24MB），286 行未回滚（payload 2516MB）
- 城市分布：北京 26/641MB、厦门 44/524MB、济南 87/368MB、成都 32/230MB、重庆 20/221MB、上海 34/150MB
- 日期分布：10-06 36 行/361MB、10-07 62 行/533MB、10-08 62 行/264MB、**10-09 114 行/1213MB**、10-10 14 行/168MB、10-11 与 10-12 各 6 行/13kB

写入方：`goldsetPlaceImport.ts`、`seed-xhs-places.ts`、`seed-xhs-relations.ts`（均为导入脚本）。
读取方：`scripts/rollback-place-identity.ts` 与测试。Web 运行时不碰。

## 3. 决策

用户决策：**归档后 TRUNCATE**（先导出可恢复档案，再截断）。

## 4. 执行过程

### 4.1 归档（本机 dev 库）

首次尝试直接把 `pg_dump -Z9` 输出重定向到 D 盘失败：WSL `/mnt/d` 是 9p 挂载，
写入速率仅约 0.9MB/s，900 秒只写了 784MB（不完整），且脚本超时被中断后容器内
`pg_dump` 残留（宿主 `pkill` 因命名空间隔离无权限终止）。

改为两步：先 dump 到 WSL 本地盘（快），再 `cp` 到 D 盘（顺序写）。

参数从 `-Z9`（gzip -9，CPU 重）改为 `--compress=zstd:3`：

```bash
docker exec -i tripweaver-pg pg_dump -U postgres -d tripweaver \
  -t place_identity_imports --compress=zstd:3 -Fc > /tmp/place-identity-imports.dump
```

结果：1106042163 bytes（1.03GB），耗时 53 秒（对比 gzip -9 的 14 分钟仍未完成）。

### 4.2 恢复校验（关键步骤）

建临时库 `tw_restore_check` → `pg_restore` → 与源库比对，两条断言同时成立才继续：

| 校验项 | 源库 | 恢复库 | 结果 |
| --- | --- | --- | --- |
| 行数 | 300 | 300 | 一致 |
| `md5(string_agg(content_hash,',' ORDER BY id))` | `600c5290cb48c4113f95c84bde82da3a` | 同值 | 一致 |
| payload 总量 | 2636MB | 2540MB | 同量级 |

校验通过后 drop 临时库，确认无残留（`tw_restore%` 匹配 0 行）。

注：`pg_restore --list` **不能**用来验证完整性 —— custom 格式的 TOC 写在文件头部，
数据被截断时 `--list` 仍然成功。必须实际恢复。

### 4.3 TRUNCATE

| | db 大小 | 表大小 | 行数 |
| --- | --- | --- | --- |
| 前 | 2791 MB | 2636 MB | 300 |
| 后 | **155 MB** | **24 kB** | **0** |

表结构完好：7 列齐全，`place_identity_imports_pkey` 与 `idx_place_identity_imports_city` 两个索引都在。

## 5. 归档产物与恢复方式

归档路径（在 `.gitignore` 的 `data/` 内，不进版本库）：

```
data/db-archive/place-identity-imports-20261016.dump
  大小   1106042163 bytes (1.03GB)
  sha256 40f4001c4685fd18c6f3e7961af497793fb26e708a33b91bef7afdbce136f403
```

恢复：

```bash
wsl docker exec -i tripweaver-pg pg_restore -U postgres -d tripweaver \
  --table=place_identity_imports \
  < data/db-archive/place-identity-imports-20261016.dump
```

## 6. 验证

- **恢复校验**：300 行 + content_hash 全量 md5 一致（见 4.2）
- **结构校验**：`\d place_identity_imports` 列与索引完整（见 4.3）
- **回归测试**：`node --import tsx scripts/verify-place-identity.mts` → **22/22 pass**
  （该脚本自建 `place_identity_test_*` 库，覆盖审计写入 / 事务预演 / 幂等 / 回滚全链路）
- **磁盘**：WSL `df` 24G → 20G used（936G free）

## 7. 已知遗留

### 7.1 WSL vhdx 未回收（Windows 侧看不到这 2.6GB）

Windows 侧 `ext4.vhdx` 仍是 **28.02GB**，而 WSL 内 `df` 只报了 20G 使用 —— 差值是
vhdx 内部未被释放给 Windows 的空洞。TRUNCATE 只释放了 ext4 内的空间。

要真正在 Windows 侧看到回收，需 `wsl --manage Ubuntu --set-sparse true`（或 `Optimize-VHD`），
**两者都要求先关闭 WSL**，而本机 WSL 里正跑着 `tripweaver-pg`、`dataease`、`mysql-det`
三个容器。本轮未做，留待用户决定。

### 7.2 写入侧会再长回来

每次城市导入都会把该城市的**整份** place identity 前后状态写成 JSONB。单行大小随城市
实体量线性增长（北京 26 行 641MB），因此这张表必然随时间重新膨胀。本轮只处理存量，
未改写入侧行为。

### 7.3 VPS 磁盘占用真因不在数据库

VPS `/` 29G 用了 23G（80%），但 DB 只占 78MB。真因是 docker：

| 类型 | 总量 | 可回收 |
| --- | --- | --- |
| Images | 6.271GB | 4.861GB (77%) |
| Build Cache | 681.4MB | 681.4MB |

用户决定本轮不处理。另一个可能是 `/var` 的 12GB（镜像层实际存放处）。
