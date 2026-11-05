# 第36批后五泉位置参考核对

本次只核对地图参考点来源，未新增实体决定、未改类别/坐标，不计完整自查。最新实体已应用36，济南台账review-13、flow38/audit34保持。

命令：

```powershell
D:/Project/xhs-travel-pipeline/.venv/Scripts/python.exe -B D:/Project/tripweaver/.trellis/tasks/10-06-place-identity-governance/research/probe-shangbu-geo.py --city 济南 --names 王府池子 腾蛟泉 起凤泉 刘氏泉 玛瑙泉 --out priority-cities/济南/geo-08.json
node .trellis/tasks/10-06-place-identity-governance/research/verify-spring-map-references.mjs
```

`geo-08.json`保存天地图5个关键词的17条原始候选及CGCS2000→GCJ02结果；`spring-map-reference-check-01.json`在下游只读事务核对五个独立ID。五个现行坐标均与原源及同名泉体POI按六位导出精度一致，未取邻近商店、街道或公厕位置：

| 地点 | 地图地址 | 尚需注意 |
| --- | --- | --- |
| 起凤泉 | 起凤桥街9号院内 | 不并入起凤桥八号商户；院内准确主体范围继续补证 |
| 腾蛟泉 | 王府池子街北端路东 | 原文2813向北走岔路口与参考方向一致 |
| 刘氏泉 | 曲水亭街南首 | 12692的簪花摄影主语未证实，仍null待审 |
| 王府池子 | 王府池子街中段 | 有两个相近同名泉体参考点，不能据此认领王府池子街、各院落或小王府池子 |
| 玛瑙泉 | 解放阁南护城河南岸 | 搜索同时命中珠宝商店，均未采用；尚需类别和完整媒体/事实核查 |

五处当前类别仍是文化。地图参考点相同不代表精确边界已证实，不据此自动改成自然类别、增加别名或通过整体验收。四泉已扫描实际独立图库无匹配，玛瑙泉本轮尚未单独补完整媒体来源。

网页搜索使用[smart-search-cli技能](C:/Users/Aimer/.codex/skills/smart-search-cli/SKILL.md)，执行`smart-search doctor --format json`。标准配置齐全且Tavily抓取连通，但主搜索模型grok-4.7返回HTTP503/model_not_found（No available channel），doctor退出1；并非缺用户API Key。未更改全局模型或配置、未调用其他网页搜索路线，没有取得新网页证据。后续可在主服务恢复后重新发现并fetch关键页面；有已知可靠URL时可通过现有smart-search fetch抓取。

额外向量复核`withdrawal-vectors-recheck-02.json`仍记录甜沫儿及趵突泉约2500ms TimeoutError；起凤泉已在第一次复核成功，趵突泉首轮有真实成功记录。唯一缺本轮真实向量成功证据的撤回项仍为甜沫儿；不改生产超时、SQL不冒充向量。

检查上游默认Web端口8000及8001/8080/8765未见监听，没有服务可在这些端口执行空闲重启。本轮治理、导出均是新CLI进程，52已安装文件哈希一致；未盲目启动或重启服务。

继续五泉的类别/精确范围及刘氏泉摄影语境、玛瑙泉其余维度，再推进济南剩余重点地点及其余八城。冻结范围978主体＋56依赖不变，云南不处理；没有任何城市整城验收通过。
