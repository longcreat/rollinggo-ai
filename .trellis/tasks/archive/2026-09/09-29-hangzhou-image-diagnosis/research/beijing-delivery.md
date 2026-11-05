# 北京试片与Unsplash来源结论

日期：2026-09-30。实现和自测已具备验收条件，任务仍in_progress，未提交、未归档。

实际预览：http://localhost:5173/trips/32c3abae-eb1e-4587-8832-5531b2169385

以用户现有《皇城园林到长城》三日行程为固定集合，只更新配图字段与更新时间；原快照在`data/photo-pilot/beijing/before-gallery-*.json`，变更在`gallery-result.json`。更新限定同一用户归属并比较原JSON，活动、路线与对话未修改。没有再生成付费行程。

| 地点 | 照片数 | 封面选择 |
|---|---:|---|
| 故宫博物院 | 3 | 角楼晚霞与护城河倒影 |
| 景山公园 | 2 | 蓝调南门与万春亭，替换旧路牌照 |
| 北海公园 | 3 | 夕照湖面与白塔 |
| 什刹海 | 2 | 冬日湖面留白 |
| 天坛公园 | 2 | 保留旧竖版夕照；强于本轮普通横图 |
| 中国国家博物馆 | 0 | 错地点与普通记录照未选 |
| 雍和宫 | 2 | 秋叶、彩绘与屋檐 |
| 颐和园 | 3 | 日落亭桥剪影，保留旧荷塘竖图作备选 |
| 八达岭长城 | 2 | 山脊城墙宽景，不用未确认段落的Pexels夕照图 |

19张全部保存在本地，C布局卡片只显示封面，点击最多切换3张并保留逐图署名。北京清单独立于杭州，可供后续北京行程复用；未声称这份行程未使用的其他候选外链都已迁移。

有限采集207条记录/73张预览，另外复看6張既有照片，共213条/79张。检索来源为Pexels、Commons与Openverse/Flickr；Openverse仅故宫成功，天坛/八达岭请求失败，最终精选为13张Pexels、6张Commons。记录、预览、原始元数据与哈希均保留；逐图身份/摄影理由在`beijing-selections.json`。原有天坛和颐和园竖图为1300px高的图源版本，等比保留，不放大。

验证：19张媒体哈希；图库7项测试（含城市隔离、八达岭/慕田峪不混用）、根目录类型检查；真实浏览器8组19张解码/切换/署名；手机无溢出且对话可见；图片查看无行程写入。结果和截图：`photo-verification/beijing/`。这只验证图片与布局，不重新评审行程路线和景点文案。

Unsplash：

- 官方图片许可 https://unsplash.com/license 允许普通免费作品下载和使用，Unsplash+应另行区分。
- 官方API指南 https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines 要求所有API图片展示使用`photo.urls`外链；用户选作封面等动作要请求`photo.links.download_location`；需展示Unsplash与摄影师署名及链接。
- 因此可考虑人工精选普通免费作品，但不直接纳入当前“API首次取得后永久自托管”的链路。未抓取Unsplash网页绕过API要求，未接入其API。
- 已执行的证据命令：`smart-search fetch https://unsplash.com/license --format markdown`和`smart-search fetch https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines --format markdown`；文件为`unsplash-license.md`、`unsplash-api-guidelines.md`。
