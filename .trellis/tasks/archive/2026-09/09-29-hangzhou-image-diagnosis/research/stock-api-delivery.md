# Unsplash / Pixabay 接入待验收记录

2026-09-30。用户确认按各源规则决定外链或本地保存，并已将两项密钥放在`apps/server/.env`。此前因要求全本地而未采用Unsplash的结论已被新需求替代。

## 可验收行为

1. 精选及已有选片优先。新搜索顺序Pexels→Unsplash→Pixabay→高德→维基，不为了扩充到3张而对已选图景点反复搜索。每个来源优先横版和氛围关键词，且须有城市、具体地点证据。这不是人工审美审核。
2. Unsplash使用原始官方图片URL，保留`ixid`，不保存图片字节。地点选择元数据持久保存；新行程采用时逐图上报`download_location`，同任务重复调用合并。仅窥探缓存或浏览已有行程不报告采用。上报失败跳过相应照片，下个任务可重试。摄影师主页、作品、许可链接含UTM。公共URL超过300字符时跳过，不截断。
3. Pixabay搜索响应的有效候选（含空结果）缓存24h；最多尝试6张下载，最终返回最多3张去重本地照片。重启、缺密钥和零搜索预算可读既有本地图。图片失败可复用搜索缓存重试，过期后允许新查询。
4. 所有新API请求由服务端进行；配置、照片API密钥和Unsplash下载事件地址不传给前端。8秒请求超时、1MiB响应上限、固定域名/路径与无重定向校验、请求预算及429退避。
5. 维持C布局和最多3张图库；切图对应自己的摄影师/来源/许可，手机和桌面均可查看。查看不会更新行程或发送对话。

## 验证

- 第一轮59项相关服务端测试通过（含8项新图库测试）；自查补充并发、429和URL中的圆明园误匹配后，新图库10项全部通过。
- `photo-layout-browser.mjs`：20组尺寸布局、3种图库视口、摄影师主页及Unsplash/Pixabay来源链接、旧单图、失败图片、零写入、零页面异常通过。`photo-verification/layout-c/gallery-390.png`为模拟图片署名截图，已目视核对。
- 最终字体来源枚举边界、UTM许可链接修正后17项新图库/精选测试通过；全仓类型检查通过，前端构建仅有原有大chunk提示。
- 用户填入密钥后，`verify-stock-photos.mts`真实测试故宫/北京：两源各3张。Unsplash返回官方hotlink且3张采用事件均成功，Pixabay3张下载并持久保存。
- `verify-stock-api-live.mts`：真实6张解码通过，原图分别为1080×678、1080×675、1080×607、1280×807、1280×908、1280×852；桌面/手机无溢出、无页面异常。读取Unsplash选择和无Key/零预算复用Pixabay照片的网络请求数为0。浏览对比页仅加载图片，不访问图源API。
- 实拍预览：`http://127.0.0.1:18799/stock-api.html`；证据`photo-verification/stock-api/{desktop.png,mobile.png,result.json}`。目视核对均为故宫宫殿/角楼景物；Pixabay第一张暮色角楼更贴近氛围偏好，Unsplash第一张石狮仍偏游客记录照。这也说明自动元数据排序不能代替审美选择。尚未改动原行程精选封面。

## 下一步

当前已具备用户验收条件。可通过实拍对比决定是否替换具体景点的精选；本轮不批量扩城或自动更改既有行程。测试脚本不调用LLM、不新建或修改行程，结果写入`data/photo-pilot/stock-api/latest.json`。

依据：[Unsplash API Guidelines](https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines)、[Triggering a Download](https://help.unsplash.com/en/articles/2511258-guideline-triggering-a-download)、[Pixabay API](https://pixabay.com/api/docs/)。官方文档抓取件保留在同目录。

尚未收到用户验收，不提交、不归档、不标记任务完成。
