# MONDOLI两条原提及的图片补证

结论仍为待补证，尚未新增身份决策。不能因为同品牌使用动物标本、复古木柜就合并，也不能仅因装修差异断言不同分店。

## 原始提及

- 3533，note1001 P10，`chengdu-case-images-02/note-1001-p10.webp`：窄角鹿头位于临门左墙，平顶有内嵌灯槽，木地板，浅色多格玻璃门窗；门外可见沿街座位、车辆及On标识。这张没有可读门牌地址。
- 3719，note1005 P9，`chengdu-case-images-02/note-1005-p09.webp`：宽角驼鹿头在灰色块状墙上，装饰花纹顶板，金属伸臂壁灯，木制吧台和黑白地砖。与另一张不是同一小块室内空间，但可能属于同店不同区域/分期装修。
- 原始库两条地址分别是宏都·美丽合江店和源野店，属于旧地理匹配结果；没有直接门店证据时不能采用它们反向证明提及归属。初始快照的mentions按不区分大小写查询，两实体都列两篇，须按原始name/mention_id核对，不能把重复出现在快照中当作共同归属证据。

## 源野店公开帖

- `chengdu-mondoli-jike-fetch.json`抓取[即刻原帖](https://m.okjike.com/originalPosts/63d535ef1e37d9e8d39ff234)，正文明确“源野的新店，还没全部开放”。
- `chengdu-mondoli-jike-images-01/manifest.json`记录原帖文件哈希、6张图的URL与字节哈希，6张均已查看。
- 图片显示黑色横梁及门框、玻璃双门与铜色长把手、卷尾犰狳状壁饰、独立木门装饰、MONDOLI品牌墙；末张杯子背后是浅色墙、顶面线脚及空调风口。未出现足以将3533或3719与之唯一对应的共同结构。
- 不能拿刚开业且局部开放的旧照片排除后续装潢变化，也不能因一张局部图未拍到鹿头就断言没有鹿头。

## 天仙桥店公开档案

- [Chengdu Expat店铺档案](https://chengdu-expat.com/places/mondoli-tangbajie)正文已抓取为`chengdu-mondoli-expat-fetch.json`，明确天仙桥南路8号附10号，描述2018年在镗钯街开店。
- `chengdu-mondoli-expat-images-01/manifest.json`冻结3张图，其中前两张为同一图的不同分辨率；已看page-01与page-03。
- page-01为木柜旁吧台视角，灰色墙角、驼鹿头侧影、金属伸臂灯与3719所拍场景有相合之处；page-03为单扇门配大玻璃窗、深木色外框。与3533浅色格窗门面尚未建立直接对应。
- 图片URL路径为2019/06，不能据此宣称这是当前装潢，也不采纳旧营业时间为当前事实。尚需能连接3533门面与具体分店的原图/店方资料。
- 既有Trip天仙桥档案的两张图片已复看；新增单条点评抓取`chengdu-mondoli-trip-review-fetch.json`没有增加可定位的照片或门店事实。

## 原作者评论补证

- `coffee-comments-02.json`的note1005线程`debac5729f4b05650c9433ba99009de3fcfcc8835e3385face6e1b5d6e1a069c`中，读者说“MONDOLI太小人太多了”，原作者回复“去源野店 那个好”。额外一页回复读取成功，线程无更多回复；这支持区分小店与源野店，但并未指出note1001照片所属分店。
- 1001和1005各读前三页30条，仍有更多，不能称已读完评论。1001的相关内容为非作者的“点点”泛化回答，不能当作原作者提供地址，更不能据其中HANDBELL磨房街猜测推翻已核实的玉林店门面。
- 旧文件未保存回复目标关联，不能仅按数组顺序配对多轮问答。本次只使用直接提及MONDOLI/源野店的文字，不把“是啊”当作对其他门店归属的确认。

## 已保留的无效检索

`chengdu-mondoli-branches-search*.json`、`chengdu-mondoli-stores-search*.json`、`chengdu-mondoli-on-search*.json`包含超时与沙箱外重试失败，不重复相同查询。`chengdu-mondoli-tianxianqiao-search.json`只用来发现Expat地址，实际判断依据为已抓取正文与冻结图片。
