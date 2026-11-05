# 摄影图库交付记录 · 2026-10-01

后续图源对比入口：http://127.0.0.1:18843/ ，详见 [图源对比记录](source-comparison.md)。小红书原试点未获用户认可；本页保留实现历史，不表示已验收。原基线是新流程的五地点有界采集，不是 TOP20 全量结果。

实现、自查及试点已完成，等待用户明确验收。未提交、未归档，任务仍为 `in_progress`。

## 可查看结果

- 汇总精选与候选审核：http://127.0.0.1:18841/
- 实际应用图库预览：http://127.0.0.1:18841/trips/ranked-photos-preview
- 上游实际控制台：http://127.0.0.1:18842/#pipeline

前两个链接由 `preview_server.mjs` 提供，只允许 GET。应用预览使用本次真实导出并导入一次性数据库后生成的行程样本，不是新保存的用户行程。没有更改用户历史行程。控制台为已安装的真实上游应用，具备任务执行能力；浏览器检查只读取、调整未提交的表单，没有发起采集。

## 样本与审核

| 地点 | 精选数 |
| --- | ---: |
| 故宫博物院 | 2 |
| 天坛 | 3 |
| 景山公园 | 1 |
| 颐和园 | 2 |
| 八达岭长城 | 0 |

最终候选 64 张：8 张合格、48 张拒绝、8 张不确定。合格 8 张全部精选，并逐图视觉核对；未观察到同图重复。不把此小样当作所有未来模型审核的准确率保证。

早期试点发现“景山机位拍故宫”错绑、人像和标语特写。`ranked-photography-v2` 增加独立主体复核后重新审核并清除这些错误选择。八达岭没有足够明确身份依据，保留空缺。

## 验证记录

- 上游相关测试：`test_ranked_photography.py`、`test_image_export.py`、`test_web_tasks.py`、`test_vision_pipeline.py`，70 passed。
- 下游 `verify_downstream.mjs`：35 passed；使用随机专用数据库，结束后删除该测试库。
- `verify_real_gallery.mjs`：真实导出 8 张、导入 4 地点，顺序/来源校验通过，同样使用一次性数据库。
- 根目录 `npm run typecheck`；上下游各自 Web 构建通过。
- `app_browser_check.mjs`：1440px/390px，4 个图库 8 张图片切换、署名、Escape、稳定封面通过，零写请求。
- `browser_check.mjs`：5 地点汇总审核页的 64 张候选图解码、桌面/手机布局通过。
- `upstream_browser_check.mjs`：真实配置表单的 TOP20/精确目标/模式/全链路开关、真实审核页 31 图解码与 CSP/非法参数验证通过。已完成任务的抽屉记录为展示样本，用于验证审核链接，不宣称通过此检查执行了完整采集。
- 前端漏署名修复：`PhotoCredit.safeCreditUrl` 补充 `www.xiaohongshu.com`，仍限制 HTTPS、明确主机、无认证信息；保留“未确认授权”。

最终缓存复跑证据为 `live/pilot-570c8f539b074951-5e4af4da.json`：`requests` 全 0，搜索缓存 4 次、笔记缓存 12 次、下载/模型缓存各 39 次。早期试点的 XHS 数字只计业务请求，未包括 vendor 登录/签名引导，不能当作实际 HTTP 总数。当前实现改为 transport 层统一预算，测试覆盖初始化中途超限和关闭会话。

攻略前后均为 437 篇笔记、2678 条提及，排行哈希：
`9a96229e9fb50c2c3a542bbf3301886ab8335426e4260309c690440258911763`。

## 安装与使用

上游修改已经通过 `install_upstream.py --apply` 安装，原文件保存在任务内 `upstream-before`，`installed-hashes.json` 记录本任务版本。独立试点数据通过 `install_pilot.py --apply` 安装到 `D:/Project/xhs-travel-pipeline/data/photography/4ad6d27e53d70a5e6e3752e3`，不覆盖已有不同内容。

CLI/Web 共享参数；默认补缺保持封面，仅显式 `refresh` 允许更换。导出媒体以内容哈希命名，下游保存 `coverImage` 和有序 `imageGallery`，地点重导保留两者。

小红书登录已过期；新搜索前在上游「配置」更新登录。现有缓存运行不初始化登录，本次验收无需新增联网采集。北京试点仅跑 5 地点，TOP20入口已实现并测试，未发起20地点全量采集。
