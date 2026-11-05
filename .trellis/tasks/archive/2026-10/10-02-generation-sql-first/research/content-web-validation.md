# 上游完整介绍 Web 与全链路接入

后续用户纠正来源分工：完整介绍已改为搜索网页与模型知识融合，小红书用于其他信息。此文保留首轮入口实现与测试记录；当前行为和最终验证见[content-research-validation.md](content-research-validation.md)。

日期：2026-10-02。实现与自测已完成，等待用户验收；任务保持 in_progress，未提交、未归档。

## 可验收入口

- http://localhost:8000/#pipeline → 完整介绍提纯补充。
- 全链路默认勾选「含完整介绍提纯补充」，grade后执行，单次默认20、范围1～200；可关闭。
- 独立作业支持当前城市、指定景点（别名/逗号/换行）、上限、仅预览。
- 最终真实任务：http://localhost:8000/?task=68b62a7306ce#pipeline 。取消/失败时保留已完成结果；进程重启后任务列表会清空，JSON报告保留。

## 实现与数据边界

共用模块`app/extract/place_profiles.py`供Web、CLI和既有脚本复用。只处理同城有效、坐标已解析的规范主景点，保留已有完整或编辑复核内容。新增介绍保存于上游`canonical_place.content_profile`，执行导出导入后同步下游，不修改已生成行程。

只从已采集且能核对原始正文的地点摘录提纯；完整笔记不进入模型输入，以免引入别的景点信息。不足20字的碎片与营销表述不进入完整介绍提纯；保留引文、数字及限定检查，并检查短引文扩写。之后机器审稿，明确标识未经编辑复核。机器通过不代表资料事实已经官方核实。

逐条生成，先持久化before/after再短事务持锁比较写入；并发变化记冲突。每条进度通过现有SSE extra传递，result保留已完成部分。报告在reports/place-content；不额外触发采集，不自动导出。

## 验证

- 86项上游定向测试通过：`test_place_profiles.py`、`test_place_content.py`、`test_web_tasks.py`、`test_ranked_photography.py`。数据库连接设置为不可用测试端口，测试均使用mock；仅有既有pkg_resources弃用警告。
- 覆盖参数非法提前拒绝、主实体/别名、已有内容保护、CAS并发、预览不写、缺资料不调用模型、审稿拒绝、取消保留成功部分、CLI/Web开关及默认值、真实短引文扩写反例。
- `compileall app scripts`、CLI两项help与上游`web/npm run build`通过（包含TypeScript检查）。
- 实际服务 http://127.0.0.1:8000：无活跃任务时重启加载，配置API注册入口与默认开关。
- 最终实际任务`f767f7eefa2b`：输入奥森/天安门城楼，映射奥林匹克森林公园/天安门，selected=0、skipped=2、saved=0，1.2秒。
- 最终实际任务`68b62a7306ce`：南锣鼓巷/地坛公园仅预览，资料不足2、保存0，1.0秒。该时间是资料不足分支，不是完整模型提纯耗时。
- 全库content_profile前后SHA256一致；本轮未增加完整介绍数量，原11条编辑复核内容保持。
- Browser技能初始化返回`Browser is not available: iab`，因此只进行了构建/API验证，没有声称完成视觉验收。

## 真实试跑揭示并修复的问题

首轮模型在长笔记输入中混入未引用信息，2条被校验拒绝。收紧模型输入后，机器审稿仍放过「来北京必逛的胡同」等短引文扩写；该轮仍是预览，没有写库。最终新增确定性完整性与营销检查，相同2个景点被正确判为资料不足。保存各轮报告，不把中间不合格样本宣称为质量达标。

证据：`content-web-smoke.json`、`content-web-smoke-before-input-fix.json`、`content-web-smoke-before-fragment-fix.json`；源码安装白名单和指纹见installer/installed-hashes。完整补丁`upstream-content-identity.patch`包含本任务累计22个上游文件，保留其他既有修改。

## 使用限制

默认按质量分处理缺失介绍；资料不足条目不会被标记为完成，下次可能再次出现。可先补采原文，或指定其他景点继续。现有脚本仍支持已抓取并核对归属的`sources-file`补充资料；本轮Web入口未新增手工原文上传或自动官方网页采集。

此轮未实跑整条采集链路，避免额外小红书采集；通过mock验证了Web/CLI全链路接入顺序与关闭开关。
