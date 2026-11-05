# 第50批：两家独立店铺的无依据坐标与类别

本批已应用并完成上下游同步，不可重放。原九城978主体＋56依赖/1135源保持，云南不扩入主动清洗；图片未查看或比对。任务仍进行中，用户尚未验收，不提交、归档或标记完成。

## 结果

完整note2573分别写明“BLUE DUCK骨董屋是自助式vintage杂货铺，超有味道”和“VILLA SHAKA的墙超好拍，咖啡也很赞”。两个来源、两条提及、两个独立主体保持，实体revision均1→2。

| 主体 | 原源/提及 | 已生效变更 | 保留待核 |
| --- | --- | --- | --- |
| VILLASHAKA / `2ccb52ac3eeda4ca713a2b7bd975b566` | 5399 / 11535 | 清空无具名POI支持的坐标，geoStatus为unresolvable；美食/cafe不变 | 纬四路和上新街分店线索不能确定原笔记所指，地址保持空，精确点未知 |
| BLUEDUCK骨董屋 / `46bf3d4bc9d5aa019dd4a3184329e58a` | 5398 / 11534 | 清空坐标，geoStatus为unresolvable；其他→购物，原shop不变；补文字地址山东省济南市市中区经三路120号 | 未获得可验证的门店精确点 |

原名称、别名、稳定ID、原始源坐标、提及和全文不改写。没有合并、新实体、撤回、分配变化或新增scope；地点位置及类别修正不需要制造文字scope。两行仍未完成完整自查，使用`reviewed_identity_media_location_pending`，不计入22行部分scope。review29仍为98行：4非地点、18行AI自查对应16主体、76未完成（22部分scope、54其余）；济南107提及待审、全范围157正式审核和4必去缺口均不变。

## 位置与公开文字依据

`vintage-geocode-provenance-01.json`复现当前旧式查询：`济南VILLASHAKA`和`济南BLUEDUCK骨董屋`均返回WGS `[117.01951,36.66462]`，转换后与两个原源的完整精度值`lng=117.02543550006231 / lat=36.664939125453756`完全相同，均无具名POI。查询“济南”返回另一个点，不能称旧点为“城市中心”。这是当前复现，不是历史写库日志证明；具名地图检索未命中两店，精确新位置仍未知。

本轮沿用smart-search CLI检索和正文抓取，查询、URL、提供方及结果保留于`shops-search-01..05.json`、`vintage-reference-01..09.json`。入口为`smart-search search`与`smart-search fetch`；实际首轮query为`济南 "VILLA SHAKA" "BLUE DUCK" 骨董屋 地址 经三路`。

- [Apple Maps BLUE DUCK骨董屋](https://maps.apple.com/place?auid=1118368912447206&lsp=57879)：`vintage-reference-05.json`有中文全名、Clothing Store及地址字段`Jingsan Road No.120, Shizhong`，支持文字门牌；不导入营业时间、评论、价格或“附近BlueDuck古着仓”为别名。
- [360地图纬四路店](https://m.map.360.cn?new=1&src=pc_shenbian&pid=e5ad4681923ba3db)：`vintage-reference-09.json`为“VILLA SHAKA为了沙卡(纬四路店)”，文字地址纬四路66号及导航坐标`116.991026,36.663628`仅作候选，没有采用。
- [新浪上新街报道](https://www.sina.cn/news/detail/5291901383082172.html)：`vintage-reference-08.json`仅支持另有“上新街为了沙卡”文字线索，未打开图片，不确认当前主体分店。
- search03生成的“经七路189号”无引用支持且与已抓取地图地址冲突，明确拒绝；无关佛教网页同样排除。reference01/02/03/04/06/07抓取失败或空内容，不作为依据。search02/04超时，03/05重试成功。
- `vintage-geo-01/02.json`具名搜索未匹配；geo03只有街道及周边点，包括济阳同名路，不能借用为门店坐标。首次地图探针在错误cwd下未加载正确配置，之后在上游cwd成功，不记作网络故障。

## 验证与保全

源包`vintage-source-packet-01.json`的SHA256为`fe0f6599fe2a96698118589810885a1cd56606065e20e64211d47a08c2be225f`；批次源`batch-50-source.json`为`5e5409177eb93db984ddf3c2e1b7f8f7c4bdc187d161990eec5e2bcad68358e4`。

- 正式预演与应用各2步。真实隔离SQL/导出/幂等/逆序回滚见`all-cities/batch-50/identity-preview-1791488391766032100/report.json`；两店内容、看点、证据和主题不变，回滚还原原有效坐标，原源不改，scope始终未新增。
- `batch-50-upstream-check.json`证明107原源/662提及/82篇全文保持、两个最终revision2正确。无生产代码安装；登记时重新核对已有60文件安装清单及暂存/实装哈希，不将第48批438/665项测试称为本批重跑。
- 全城228地点/18关系/direct3双导出、真实双导入及倒序回滚预演、实库同步和向量回填通过。来源revision24；关系内容0变化。导出哈希`6b384afe8d60211003da7eb498c23b95f53624326c5dc015384e3a5f3734369b`，关系哈希`63a26a27ffa4a6d31701220a8bf3d4678bbf42f470ca41423423e885326e267d`。
- `vintage-downstream-check-01.json`比对228实际消费行、268既有最新分配、107待审及全部审核/scope/scopeSource；4名称SQL、2真实向量、40名称/旧ID边界通过。正常和带空格英文名都命中，另一家店、泛店名、附近古着仓、候选分店名和地址均不能绑定到当前根。其他事实及缓存保持；全城旧看点时间差详见下一节。
- `vintage-consumption-1791488705921.json`实际调用placeFacts，坐标缺失、店铺购物/cafe美食与其他有效事实正确。238旧行、90图片字段、9绑定和201历史行程保持，行程摘要`e01d67cbf42a62fc595f4ef052f99e75`。
- 老商埠实际3图摘要`2c29d7b93a412f38eb21d6ce3ece4f175e0576dee87bee3a179d5bb095868603`、经三路1图摘要`2143dbc77997beeaf461e337c7f018783583096ae8e60dac777fba41cdbefddd`前后保持。两目标旧/新均无图。未新增scope的无图主体按既有规则请求补图，隔离mock回调前后各2次，真实入队0；不能声称回调0。
- 消费测试前几次探针分别修正英文事实map须用`placeNameKey`、无坐标属性缺省、既有无图回调基线比较，失败日志保留；没有为通过探针改生产代码。成功日志为`downstream-place_identity_test_1791488698831.log`和`upstream-stage-place_identity_test_1791488390215.log`。
- flow52为303正例/113边界/47撤回，0失败，cleanup证明临时库已删除；audit48为287 PENDING，0结构错误（济南107提及＋6实体对）。全仓及扩展TypeScript检查通过。

## 独立元数据发现：旧看点日期回填

旧消费报告中`fallbackObservedAtMeaning`的“缺失采集日期”说明过宽。该报告保留原样，新增`vintage-timestamp-provenance-01.json`明确更正：**是旧看点没有携带observedAt，不是原始来源没有日期**。探针源代码的注释及说明已同步纠正，未重放实库变更。

148条看点/127实体的变化均严格满足旧observedAt等于旧compiledAt、新observedAt等于新compiledAt，text/quote/sourceUrl/strength/顺序/intro保持。只读溯源匹配165条真实提及、32篇笔记；全部匹配都带`RawNote.created_at`，其中13个匹配走受控legacy reason、152个走普通legacy reason。一个看点可以有多个相同来源候选，此计数不代表新增独立证据。

`load_mention_rows.observed_at`来自`RawNote.created_at`；普通导出和受控导出调用`legacy_highlights(reason,url)`均没有传递该日期，`build_place_content`随后以编译时间回填。溯源用真实有效字段逐条匹配text/quote/sourceUrl，分别输入两次compiledAt重现结果；不把created_at进一步解释为游览或发布时间，也不宣称拿到了历史写库日志。

此行为尚未修复，作为独立元数据发现登记，不混入老商埠/经三路两项未应用商业文字发现，也不把整城元数据变化称为“内容完全无变化”。上游`place_content.py`尚不在安装清单，本批没有直接改动它。

## 继续位置

实体batch50 / 图片batch03，当前指针review29、flow52/audit48，`pendingVerification=[]`。下一数据批次用51、flow53/audit49。两个店铺精确位置与图片仍待核，百花洲12946和两项商业文字发现保持原状态；另有上述日期元数据问题待修复。全任务及goal保持进行中。
