# Workspace Cleanup Guide

> **Purpose**: 清理工作区、枚举未跟踪文件、避免并发会话互相污染 git 索引。

---

## 硬约束

### 枚举未跟踪文件必须用 `-z` + 字节级 UTF-8 解码

git 默认对含非 ASCII 字符的路径输出带引号的八进制转义（`"…\350\245\277…"`）。直接拿这个字符串做 `Test-Path`，中文路径会**全部判为不存在**，删除动作静默漏掉一半文件。

```powershell
$enc = [Text.Encoding]::UTF8
$t = Join-Path $env:TEMP 'st.bin'
cmd /c "git -c core.quotepath=false status --porcelain -z -uall > `"$t`""
$recs = ($enc.GetString([IO.File]::ReadAllBytes($t)) -split "`0") | Where-Object { $_ }
$untracked = $recs | Where-Object { $_ -match '^\?\? ' } | ForEach-Object { $_.Substring(3) }
```

- 必须用 `cmd /c ... > file` 重定向取原始字节；PowerShell 管道会按控制台编码解码，中文路径照样损坏
- 判断未跟踪一律用正则 `'^\?\? '`；`-like '?? *'` 里 `?` 是通配符，会误匹配 ` M ` 行

### 删除前必须与 `git ls-files` 全集比对

未跟踪文件不在 git 里，删掉不可恢复。先用一次 `git ls-files -z` 建集合，再校验待删列表与已跟踪集合交集为空：

```powershell
$tracked = [System.Collections.Generic.HashSet[string]]::new()
foreach ($p in ($enc.GetString([IO.File]::ReadAllBytes($lsBin)) -split "`0")) { if ($p) { [void]$tracked.Add($p) } }
$bad = @($targets | Where-Object { $tracked.Contains($_) })
if ($bad.Count) { throw "命中已跟踪文件，中止" }
```

不要对每个文件单独调 `git ls-files --error-unmatch`：800 个文件就是 800 次进程启动，命令会卡死。

### 不要用「整索引」提交

多会话并行时 `.git/index.lock` 会出现竞态，`git add` 挂上的暂存区可能在几分钟后属于别人。每次都用**一条命令完成 add 与 commit**：

```powershell
git add -A -- <显式路径>; git commit -q -F <消息文件>
```

提交前把 `git diff --cached --name-only` 与预期路径清单比对，越界就中止。

---

## 归档任务的旧路径残留

任务归档到 `.trellis/tasks/archive/<月>/<id>/` 后，旧路径 `.trellis/tasks/<id>/` 下常留下未跟踪文件（研究产物、截图、快照）。判定方式：

1. `git ls-files -- .trellis/tasks/<id>` 为 0 且 archive 下同名目录有跟踪文件 → 是残留
2. 与 archive 同名文件比对**大小和 mtime**：一致即纯副本，可删；更新则是新生成的证据，需人工判断

---

## 通常不必提交的文件

| 类别 | 例子 | 处理 |
| --- | --- | --- |
| 上游安装备份 | `research/upstream-install-backups/<sha>/**`、`research/upstream-backup/**` | 是 `research/upstream/` 已跟踪内容的重复副本，删除 |
| 跑批中间态 | `batch-*/sync-01/*.json`、`flow/run-*/` | 只有最终台账需要入库 |
| 归档任务的旧路径截图 | `.trellis/tasks/<id>/research/verification/*.png` | 见上一节判定后删除 |
| 工具运行时状态 | `.pi/goals/`、`.pi/.goals-pool-snapshot.json` | 写进 `.gitignore` |
| 类型声明中间物 | `*.d.mts` | 若被同目录 `.mts` import 则**必须提交**，否则类型退化 |
