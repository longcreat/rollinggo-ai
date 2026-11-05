# 验证记录（待用户验收）

## 已验证
- `npm run typecheck`：通过。
- `npm run build -w apps/web`：通过；保留现有大包体积提示。
- `node apps/web/tests/login-dialog-browser.mjs`：通过。覆盖访客首页、无私有接口请求（含旧任务缓存）、登录失败、Escape 与焦点返回、关闭保留草稿、密码登录后自动规划、退出、深链回跳、会话失效、OAuth 错误提示、手机尺寸和非 401 服务错误。
- `node --import tsx apps/web/tests/navigation-notifications-browser.mjs`：通过。验证现有通知、生成恢复、离开保存和手机交互未回归。
- 本地真实服务（无 Cookie）：`GET /api/destinations/covered` 为 200；`GET /api/trips`、`GET /api/generations/current` 为 401。
- 已目视检查 `login-desktop.png`、`login-mobile.png`，弹窗尺寸与内容正常。

## 实现说明
- 公共 AppLayout + 受保护行程子路由；登录 provider 放在账号 key 边界外。
- me 的匿名 401 转为 null；非 401 仍报服务错误。退出/过期显式发布 null 再删除其他查询，避免公共布局保留旧账号菜单。
- 退出先通过原有离开保存守卫回首页，再注销，防止 RequireAuth 将主动退出误判为需要登录。
- 访客使用本地默认偏好，禁用账号查询和生成恢复；城市名称端点公开，其他服务鉴权保持。
- 注册与登录在同一弹窗内切换；直接访问 /register 在首页打开注册模式。密码注册成功默认回首页，保留合法内部回跳目标。GitHub 真实授权未操作，回调错误展示已验证。

## 验收调整
- 删除弹窗卡片内的品牌块（「织程 TripWeaver」与「AI 替你刷攻略、排行程」），保留弹窗标题「登录织程 / 注册织程」；注册卡片的说明文案「注册即可开始规划」同样删除，弹窗内只留标题与表单。
- `npm run typecheck` 与 `node apps/web/tests/login-dialog-browser.mjs` 均通过，桌面、手机截图已重出。
- `Modal` 新增 `size="auth"` 变体（`max-w-[360px]`），登录与注册弹窗改用它，收窄为竖长方形；其他弹窗仍为 480px。

## 交付状态
实现和自测已具备验收条件。未创建提交、未归档、未标记完成；等待用户明确验收。

## 必填校验补充
- 删除访客绕过 ready 的分支，登录前后共用目的地、节奏与偏好就绪判断。
- 未选必填项时按钮禁用，并显示“先选目的地与节奏”；页面提交处理也在条件缺失时直接返回。
- 浏览器回归已覆盖：全空禁用、不弹登录、只选目的地仍禁用、选齐后启用并弹出登录，以及认证成功继续规划。

## 注册弹窗补充验证
- 登录/注册切换 URL 不变，关闭保留首页草稿。
- 密码不一致不提交；注册成功关闭弹窗并继续原始深链。
- 直接 /register、邀请码模式、关闭注册提示与返回登录通过。
- 注册手机/桌面预览：register-mobile.png、register-desktop.png。
