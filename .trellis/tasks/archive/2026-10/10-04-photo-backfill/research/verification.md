# 验证记录（待用户验收）

- `npm run typecheck`：shared/server/web/eval 全部通过。
- `node --import tsx --test apps/server/src/__tests__/photoReviewQueue.test.ts apps/server/src/__tests__/tripPhotos.test.ts apps/server/src/__tests__/selectedPhotos.test.ts apps/server/src/__tests__/reviewedPhotos.test.ts`：16/16通过。
- 定向 `git diff --check`：通过（Windows CRLF提示不影响结果）。
- 当前 apps/server/.env 未显式设置 PHOTO_REVIEW_DAILY_PLACES；服务热加载后使用默认50，杭州12个任务已提升为trip，后台实际开始处理。
- Playwright 使用真实杭州行程数据库快照、正式详情补图纯函数、人工/审核图库查询及真实图片URL；认证及API通过隔离回放提供，不是用户登录会话，也没有修改真实行程。读取图库时不另启worker或写队列，避免多消费者。
- 最新浏览器结果：9/12景点照片成功解码，0 pageerror、0 PUT/PATCH/DELETE；其余曲院风荷、柳浪闻莺、雷峰塔在快照读取时尚无图。结果见browser-result.json，完整照片预览见hangzhou-photo-preview.png。
- route-options POST是前端查询路线选项，由回放拦截，未发送到真实服务；地图底图不是本次验证目标。
- 回放脚本第一次宽泛 /api/ 拦截误拦src/api模块，第二次未切换天数找不到跨日景点；已限定根 /api/ 路径并按天切换，最终通过。
- 原数据库overview仍为0张；详情只增强响应，不覆盖原版本、时间戳或已有照片。刷新可使用随后产生的审核结果；当前打开页面不自动轮询。
- 代码按trellis-check检查，规范同步到preference-photo-pipeline.md。未提交、未归档，等待用户验收。

## 与排查阶段的补充
新版审核图库按城市摘要分子目录，不能只扫描reviewed根目录判断有无结果。正式查询器递归到对应城市目录。手动预热/状态入口已存在于apps/server/scripts/review-place-photos.mts（先前只搜索根scripts而遗漏）；服务运行期间禁止另起CLI消费者。
