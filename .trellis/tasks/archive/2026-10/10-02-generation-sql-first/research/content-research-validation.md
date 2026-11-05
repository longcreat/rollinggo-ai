# 搜索与模型知识生成完整介绍

2026-10-02。按用户纠正，将完整介绍从小红书短摘录改为搜索网页+模型知识；未提交、未归档，等待验收。

## 当前分工

- 完整介绍：smart-search发现网页，政府/文旅优先，抓取最多3页正文；模型根据网页事实组织定位、历史、格局和看点，并可补充稳定的一般背景知识。
- 小红书：既有提纯继续补充体验、避坑、交通、时长等信息。完整介绍作业不查询小红书摘录，也不依赖笔记是否存在。
- 已复核/完整介绍继续保留。新介绍存储表与导出导入路径不变，默认补缺，每次20、最多200，支持预览及取消。

## 入口与配置

上游 http://localhost:8000/#pipeline →「完整介绍提纯补充」；Web与CLI一键全链路均调用共用模块。CLI与脚本支持`--search-model`，Web有对应字段。

本机smart-search全局默认grok-4.6已不可用，doctor返回model_not_found；本任务逐次指定网关已列出的grok-4.7，未修改全局模型配置。搜索、正文抓取均使用smart-search-cli，不使用内置web搜索替代。

## 来源与质量契约

- 网页事实支持`sourceIds`多片段引用，程序保存每段原文为`citations`，不拼造引文。模型知识用`basis=model_knowledge`，quote/sourceUrl为空，不伪造出处。
- 模型知识最多占正文一半，不补未经核实的具体数量、年代和实时政策；网页引用必须匹配同城地点和实际正文，搜索摘要不能作为已抓取原文。
- 每页最多16个稳定片段，优先主体定位/历史/建筑，避免长网页占满输入。模型无效结构/引用可纠正重写一次；审稿不通过仍拒绝保存。
- 目标三句话、120～180字；超200字只能舍弃末尾完整句，不从句中截断。未使用的近似面积不应误拦无关文案，但正文使用近似数值必须保留“约”。
- 搜索资料按城市/名称/模型缓存7天；失败不缓存。Windows调用Node CLI入口和参数数组，不拼shell，超时/取消结束进程树。
- 前端展示网页引文及模型知识来源类型；下游`purifiedIntroSources`展开所有citations，过滤非法URL并去重。

## 验证结果

- 上游108项定向测试通过（搜索、介绍、既有内容、Web任务、全链路摄影隔离）；使用mock和不可用测试DB端口，未对真实库运行单元测试。
- 下游researchQuality 6项测试通过；全项目typecheck通过。
- 上游Web构建通过，CLI两个入口help通过，Python compileall通过；Browser在本会话此前返回不可用，因此未宣称视觉验收。
- 真实任务`af263558db71`：http://localhost:8000/?task=af263558db71#pipeline 。2个地点预览，生成1、审稿拒绝1、搜索失败0、保存0；复用先前抓取的6页缓存，用时13.5秒，不能当成首次联网搜索耗时。
- 南锣鼓巷成功生成完整段落，采用北京日报与北京旅游网页面正文，介绍涵盖历史、街巷格局与可园。该次结果全部为网页事实句，未使用额外model_knowledge句；模型知识融合及无伪造引用通过专门单元测试验证。
- 地坛公园草稿把绿色琉璃瓦改成黄色、牌楼改成核心祭坛，机器审稿明确拒绝。没有将被拒内容写入库。
- 全库content_profile前后SHA256一致。本轮不增加已复核数量，也未更新旧行程。

证据：`content-research-smoke.json`（最终）、`content-research-smoke-first.json`、`content-research-smoke-second.json`。完整上游补丁累计24文件；脚本保留备份与指纹，未覆盖其他并发修改。

## 来源示例与复现

- 北京旅游网：https://www.visitbeijing.com.cn/article/47QkViBYPUp
- 北京日报：https://peking.bjd.com.cn/content/s67c6ffd5e4b08edd28f5c74b.html
- 搜索命令：`smart-search search "北京 南锣鼓巷 景点完整介绍 历史 胡同格局 官方 文旅 政府" --model grok-4.7 --extra-sources 3 --timeout 60 --format json`
- 正文：`smart-search fetch "https://www.visitbeijing.com.cn/article/47QkViBYPUp" --format json`
- 应用：`python -m app.cli refine-content --city 北京 --names 南锣鼓巷 地坛公园 --limit 2 --preview --search-model grok-4.7`

没有重跑整条小红书采集链路；全链路开关与参数传递由测试覆盖。搜索/模型本身仍可能失败或引用错误，界面按地点展示原因；不把机器审稿等同于编辑复核或用户验收。
