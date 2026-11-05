# 西安batch-23：范围补证与坐标纠错

## 证据及结论

已重新读完冻结的2760、2775、2641、2725、2704、2721全文。潜龙寺源12551明确乘缆车到山顶拍寺院红墙，12455明确使用潜龙寺景区名；2725的12224是开元商城六楼钟鼓楼同框机位，2721分列五楼两处平台及六至七楼步梯。

公开来源均通过smart-search fetch取得正文，未将search模型的“我先检索”意向句当作事实：

1. [陕旅集团少华山介绍](https://www.sxtourgroup.com/home/guanzhonglishiwenhua/info/id/2596/catId/242.html)，来源少华山，2022-03-28，明确公园位置及五大景区包括潜龙寺景区。冻结`xian-qianlong-tourgroup-fetch.json`。
2. [国际在线少华山介绍](https://sn.cri.cn/n/20190313/ea802a15-c21f-18e8-509e-39fe25d3c40e.html)，2019-03-13，来源渭南市委宣传部，确认渭南市华州区及五大分区。冻结`xian-qianlong-cri-fetch.json`。
3. [潜龙寺景区词条](https://baike.baidu.com/item/%E6%BD%9C%E9%BE%99%E5%AF%BA%E6%99%AF%E5%8C%BA/6663579)，正文明确景区因寺得名、约360公顷的范围、其他景点及以寺为中心的游览轴。作为具体范围补充，与官网分区及原笔记对照；未采用开放时间、历史传说或门票作为产品事实。冻结`xian-qianlong-baike-fetch.json`。

命令留证：`smart-search search "少华山 潜龙寺景区 潜龙寺 寺院 五大景区 官方" --extra-sources 3 --timeout 60 --format json --output <search文件>`；随后分别`smart-search fetch <上述URL> --format json --output <对应fetch文件>`。沙箱内首次search超时，沙箱外重试成功；两份文件均保留，三次fetch成功。

## 已应用变更

- 潜龙寺`4a4505a1baed0f14c8a4fe6386bc5798`是寺院；潜龙寺景区`cac7b5d4f244dad808626ba1590c38f2`是包含它的游览分区。审核425登记part_of，不归并ID或别名。
- 两者原34.241770/108.902733误在西安高新区，成对清空经纬度并标记unresolvable，地址写明渭南华州少华山。当前“西安”仍为来源城市目录，不以改city破坏既有引用；物理位置明确放在地址，未伪造GCJ-02点。
- 开元商城六楼`202788eb4f60cff0ca71ae79e5709fa1`旧108.912271偏离钟楼开元商城约3公里，清空错误点。383泛称仍涵盖多个楼层机位，继续uncertain。
- 共3字段决策＋2审核。batch-23已经apply:true，禁止重放。生成器补充`xian-batch13-supplement.json`以重建batch-13；首轮遗漏导致生成/隔离预演失败，详见`batch-23-draft-01-failure.md`，未写实库。

## 验证

- 隔离幂等、倒序回滚成功，日志`../upstream-stage-place_identity_test_1791329161382.log`；实库事务预演5项成功后正式应用。
- sync-01：西安397条完整export→import→embed，导入审计`7737934d-757b-4ce0-afc7-66c63d1e456f`。3名称/3真实向量、字段、旧ID核验0失败；397现行根/397有向量，匹配照片0。
- `flow/run-23`西安15正例无失败，425两ID候选、排程、编辑及实际保存读回通过；全城243正例、113独立/包含持久化，12未导出负例。仍仅CUIDA/MONDOLI两组4条catalog_alias歧义，退出1如实保留；不带ID拒选、带正确ID分别选择防护通过。cleanup确认临时库已清理。
- `audit/run-19`140条PENDING/139对，全部uncertain，西安1条历史同对重复，无非法根、同根悬挂。完整目录07与队列139对相符，无须额外入队。

以上未覆盖外部模型、地图、营业时间准确性或浏览器；未声称全产品E2E或用户验收通过。未提交、未归档。
