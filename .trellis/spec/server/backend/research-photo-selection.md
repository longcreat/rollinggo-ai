# 独立图源对比网站的个人选择

## 1. Scope / Trigger

仅适用于 `.trellis/tasks/09-30-ranked-place-photography/research/compare_all_server.mjs` 提供的本机18845研究网站。它不是正式应用路由；选择不修改行程、精选清单、来源优先级或摄影审核结果。

2026-10-02 用户已另行授权将此前北京快照用于正式选图。一次性导入与生产优先级遵循[人工选图与审核补图库](./preference-photo-pipeline.md)；此网站的点击/保存本身仍不会自动发布新选择。

## 2. Signatures

- `GET /api/selections`：读取当前反馈，无文件时返回空状态，纯浏览不落盘。
- `POST /api/selections`：`{catalogVersion, revision, operationId, kind, ...}`。
- `kind: rating`：`{key, value: selected | rejected | unmarked}`。
- `kind: place`：`{place, value: in_progress | done | none}`。
- `kind: note`：`{place, value: string}`，最多1000字。
- `kind: snapshot`：冻结当前反馈与可预览候选的关联，供后续人工/AI对比分析。

## 3. Contracts

- 正式反馈位于该任务 `research/live/all-pools-feedback/selections.json`，快照位于相邻 `snapshots/`，不在静态文件服务根目录内。浏览器备份由显式导出产生。
- `schemaVersion=1`；`catalogVersion`由候选组确定；每次成功操作递增`revision`并记录时间。同一`operationId`重试返回已提交状态，旧`revision`拒绝覆盖。
- 同景点照片仅根据作品页面、图片直链或内容哈希关联；跨景点不共享选择。高德POI页面、小红书笔记链接是集合地址，不是单图身份。
- 仅已取预览和当前行程图片可选择；评分、AI审片及原始来源字段分别保存。快照保留所有同图记录用于追溯。
- 后续分析把`selected`当正样本，`rejected`当明确负样本，`unmarked`保留未知。`none`表示景点未选出合适图片，不自动伪造逐图负样本。只对`done/none`景点归纳，未完成景点单列。
- 保存使用串行队列、同目录临时文件及原子重命名；浏览器在保存中禁用变更按钮，失败显示“保存未确认”并要求重读，不显示虚假成功。
- 服务仅监听127.0.0.1；校验实际本机Host；POST要求同源Origin、JSON和`X-Photo-Review: 1`，不允许任意路径写入。

## 4. Validation & Error Matrix

| 情况 | 结果 |
| --- | --- |
| 无反馈文件 | 200空状态，revision 0 |
| 未知图片/景点/状态、超长备注 | 400，不写入 |
| 已选图片时提交none、无已选图片时提交done | 400，要求用户修正 |
| 非同源写入或不合法Host | 403 |
| 数据集变化、过期revision | 409，保留旧数据 |
| 请求体超过16KiB / 非JSON | 413 / 415 |
| 文件读取/保存失败 | 500，前端明确报错并可重读 |

## 5. Good / Base / Bad Cases

- Good：选择故宫一张精选，其当前行程副本同步选中；选择第二张小红书同笔记图片不会牵连第一张。
- Base：完成部分景点便可保存分析快照，剩余景点仍待选；之后修改评分使该景点重新进入挑选中。
- Bad：把没选或没展开的图片全记为不喜欢；把同一个高德POI的所有照片合成一张；直接采用用户偏好图到正式图库。

## 6. Tests Required

`node .trellis/tasks/09-30-ranked-place-photography/research/compare_selection_verify.mjs` 使用独立临时反馈目录和随机端口，不得向真实用户选择写入测试数据。

覆盖同图关联、POI/笔记不同图分离、同源及输入限制、revision冲突、幂等重试、选择取消排除、备注刷新、完成/none、快照未知标签、导出、失败恢复、手机溢出、服务重启恢复以及候选文件未变。

## 7. Wrong vs Correct

```js
// Wrong: a collection page may contain many different pictures.
identity = photo.sourceUrl;
negative = !selected;

// Correct: only single-work URLs/bytes identify equivalent pictures.
if (!['amap', 'xhs'].includes(photo.source)) addWorkIdentity(photo.sourceUrl);
negative = feedback.ratings[key] === 'rejected';
```
