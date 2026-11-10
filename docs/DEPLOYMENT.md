# 部署与配置

面向**站长**：把自己的rollinggo 旅行跑起来，配哪些 Key、花多少钱、怎么挂 CDN。

只想本地跑一下看效果，看 [README 的快速开始](../README.md#快速开始) 就够。

## 快速部署

```bash
git clone https://github.com/longcreat/rollinggo-ai.git && cd rollinggo-ai
cp .env.example .env
# 编辑 .env：至少填 MASTER_KEY（生成命令见文件内注释）、站点 LLM Key
docker compose up -d
```

默认拉取 `ghcr.io/longcreat/rollinggo-ai:latest` 预构建镜像；镜像不可用时用 `ROLLINGGO_TRIP_IMAGE='' docker compose up --build -d` 本地构建。

app 只绑 `127.0.0.1:3001`，由宿主机 Nginx 转发，站点配置参考 `nginx.host.conf`（含 SSE 关键参数）；想用容器内自带反代则改用 `docker-compose.release.yml`。

浏览器打开你的域名（或 `http://服务器IP`），注册即可（默认开放注册；想收紧时设 `REGISTRATION_MODE=invite` + `INVITE_CODE`）。

### 本地开发

```bash
npm install
cp .env.example apps/server/.env   # 填 MASTER_KEY 等
npm run dev                        # server:3001 + web:5173
```

PostgreSQL + pgvector 用 `docker compose up -d db` 起（或指向已有的本机 / Neon / Supabase 实例）。

---

## 环境变量

标注 ✅ 的缺失时服务拒绝启动。完整注释见 [`.env.example`](../.env.example)。

### 必备与账户

| 变量 | 必填 | 说明 |
|---|---|---|
| `MASTER_KEY` | ✅ | 32 字节 hex，用户 API Key 的加密主钥 |
| `DATABASE_URL` | ✅ | PostgreSQL 连接串（本地开发可指向本机 PG 或 Neon/Supabase） |
| `POSTGRES_PASSWORD` | | 仅 `docker compose` 部署的 postgres 服务密码，留空则用 compose 默认值 |
| `REGISTRATION_MODE` | | 注册模式 `open` / `invite` / `closed`；**未设置时自动推断**：`INVITE_CODE` 非空 → `invite`，否则 `open`（存量部署升级后行为不变） |
| `INVITE_CODE` | | 邀请码，仅 `invite` 模式使用（该模式下必填）；遇滥用时切 `REGISTRATION_MODE=invite` 即可收紧注册 |
| `RESEND_API_KEY` / `MAIL_FROM` | | 注册邮箱验证码与找回密码。缺失时这两条路径返回 503，其余功能不受影响。`MAIL_FROM` 的域名须先在 Resend 后台验证（Cloudflare 加 DNS 记录） |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | | GitHub OAuth App 凭据；留空 = 不显示 GitHub 登录 |
| `APP_BASE_URL` | | 站点对外地址（如 `https://trip.example.com`），启用 GitHub 登录时必填，用于构造回调 URL |

### 模型与额度

| 变量 | 必填 | 说明 |
|---|---|---|
| `SITE_LLM_BASE_URL` / `SITE_LLM_API_KEY` / `SITE_LLM_MODEL` | 建议 | 站点供 Key（普通用户零配置使用）；留空 = 纯 BYOK 模式 |
| `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` / `EMBEDDING_DIMS` | 可选 | 知识库向量召回。留空即不生成向量、检索退化为纯关键词；未填时回落到 `SITE_LLM_*`（OpenAI 兼容端点普遍同址提供 `/embeddings`）。`DIMS` 必须为 1024，与库内 `vector(1024)` 列对齐 |
| `GEN_DAILY_LIMIT` | | 每用户每日生成次数（默认 3） |
| `CHAT_DAILY_LIMIT` | | 每用户每日对话轮数（默认 40），与生成配额相互独立、不互相占用 |
| `SSRF_ALLOWLIST` | | BYOK baseUrl 私网豁免（站长自有 Ollama 等） |

### 地图与搜索（均可选，都不填 = 纯模型知识调研）

| 变量 | 说明 |
|---|---|
| `AMAP_KEY` | 站点默认高德 Web 服务 Key；用户可在设置页保存仅自己可用的个人 Key，优先级为「个人 Key → `AMAP_KEY` → Null 降级」。负责地理编码与路线规划。[申请入口](https://console.amap.com/dev/key/app) |
| `SEARCH_API_KEY` / `SEARCH_API_BASE_URL` | 站点默认 Web 搜索 Key 与端点。默认 [LangSearch](https://langsearch.com/)（免费）；[博查](https://open.bochaai.com) 同族接口改 URL + Key 即可切换 |
| `QWEATHER_API_HOST` | 和风天气**专属 API Host**（形如 `abcxyz.qweatherapi.com`）。它也是身份认证的一部分；公共域名自 2026 年起逐步停服，**不要回落** |
| `QWEATHER_JWT_{KEY_ID,DEVELOPER_ID,PROJECT_ID,PRIVATE_KEY}` | **推荐**：Ed25519 私钥现签 JWT（token 最长 24 小时，静态串过期即 401）。四项须同时配置 |
| `QWEATHER_KEY` | 备选：API Key（走 `X-QW-Api-Key`）。填成已签好的 JWT 时自动改走 `Authorization: Bearer`，仅供临时排查 |
| `AMAP_JS_KEY` / `AMAP_JS_SECURITY_CODE` | 前端地图渲染用的高德 **「Web端(JS API)」** Key（与 Web 服务 Key **不通用**）与配套安全密钥。两者都会下发到浏览器（JS API 的设计，靠域名白名单限权）。留空则前端地图走 Leaflet + 栅格瓦片 |

各数据源的每日预算：

| 变量 | 说明 |
|---|---|
| `AMAP_QUOTA_ENFORCE` | **默认 `false`（2026-11-06 起，测试环境口径）：高德日预算只记账观测、不拦截**，实际消耗受高德账户自身月配额约束。置 `true` 恢复硬闸门（预检失败降级 Null 源）。详见[高德限额与日志](AMAP_QUOTAS.md) |
| `AMAP_LBS_MONTHLY_BUDGET` / `AMAP_SEARCH_MONTHLY_BUDGET` | 个人认证默认 150000 / 5000，按 31 天折算服务日预算，详见[高德限额与日志](AMAP_QUOTAS.md) |
| `AMAP_{GEOCODE,PLACE,WALK,CYCLE,DRIVE,TRANSIT}_DAILY_BUDGET` | 六项独立上限；默认 POI 搜索 161，其余各 967。0 禁用（仅 enforce=true 时生效）；五项 LBS 合计不得超过月预算 / 31 |
| `AMAP_PHOTO_MAX_PER_TASK` | 景点图查询单任务上限（默认 40）；图片已收敛为高德 POI photos 单源 |
| `SEARCH_DAILY_BUDGET` | 全站搜索调用日额度（默认 500，超出自动降级） |
| `QWEATHER_DAILY_BUDGET` | 全站和风调用日额度（默认 200，应用上限非官方套餐额度）。每个目的地最多 2 次请求，城市缓存 24h、预报缓存 1h |

### 图片素材与分享图

| 变量 | 说明 |
|---|---|
| `AMAP_PHOTO_MAX_PER_TASK` | 景点图片唯一来源是高德 POI photos（名字闸门 + 类型白名单 + 24h 缓存 + 库内回写），单任务查询上限默认 40。旧的多源图库（Pexels/Unsplash/Pixabay/Wikimedia）与视觉审核队列已于 2026-11-04 删除，`PEXELS/UNSPLASH/PIXABAY/PHOTO_REVIEW_*` 变量不再使用 |
| `IMAGE_API_BASE_URL` / `IMAGE_MODEL` / `IMAGE_API_KEY` | AI 分享图：默认第三方 OpenAI Images 兼容地址 `https://xjbh.lol/v1`，模型 `gpt-image2.5`，需独立密钥。可用 `_2` / `_3` 后缀追加中转站（最多 3 个，按序降级）。[配置说明](AI_SHARE_IMAGES.md) |
| `MEDIA_STORE` | 图片与图源索引的存储后端：`local`（默认，宿主机 `./data`）或 `s3`（Cloudflare R2 / MinIO / 任意 S3，桶内布局与 `data/` 一致）。改这一个值即切换读写两侧，不用重导数据库 |
| `MEDIA_S3_*` | `MEDIA_STORE=s3` 时必填五项（endpoint / bucket / access key / secret / region）。endpoint 只到域名层级（R2：`https://<account_id>.r2.cloudflarestorage.com`）；region 留空即 `auto`。缺任一项启动即报错 |
| `MEDIA_BASE_URL` | 展示用 URL 前缀，默认 `/media`（同源）。挂 CDN 时填完整前缀，R2 自定义域名映射桶根所以是 `https://media.example.com/media` |

---

## 调研数据源（高德单源 + 全网搜索）

调研 Agent 与详情对话 Agent 的数据源（2026-11-05 起天地图已整体下线，全部走高德）：

1. **高德 Web 服务**：地点文本/周边/多边形检索（`v5/place/text|around|polygon`）、地理编码（v3）、路径规划（v5）。个人认证无流量包时基础 LBS 15 万次/月、搜索 5000 次/月，详见[高德限额与日志](AMAP_QUOTAS.md)
2. **Web 搜索 API**：玩法、避雷与「是否需要预约」等攻略信息，带来源链接。用户可保存个人 API Key 与 Base URL（Key 以 AES-256-GCM 加密、仅显示尾号），个人配置优先，清除后回退站点配置，两者都不可用时 Null 降级
3. **预约种子表**：仓库内置约 50 条全国热门「需预约」景点（故宫/国博/莫高窟/陕历博等），命中即直接标注预约方式与官方链接，离线可用（`packages/core/src/data/reservationSeeds.json`）
4. **和风天气**：15 天逐日预报；配置方式见 `.env.example` 的 `QWEATHER_*` 段（推荐 Ed25519 JWT 现签）

前端底图**默认走 Leaflet + 高德栅格瓦片**；配了高德 **JS API** 凭据后自动切成高德 JS API 渲染 —— 这样才能隐藏未编入行程的 POI 文字（栅格瓦片把文字烘焙进图片，关不掉）。Key 缺失、接口未取到、或 SDK 加载失败/超时都**静默降级**回 Leaflet，编辑器不会出现没有地图的情况。

启用 JS API 渲染需要在[高德控制台](https://console.amap.com/dev/key/app)单独申请一个 **「Web端(JS API)」** 类型的 Key：创建时填**域名白名单**（本地开发填 `localhost`，线上填自己的域名），再把配套的**安全密钥**一起填到 `AMAP_JS_KEY` / `AMAP_JS_SECURITY_CODE`。两个值都会明文下发到浏览器 —— 这是 JS API 的设计，安全性靠域名白名单而不是保密，**不要当成秘密**。前端底图无论走哪条路都是 GCJ-02（与库内坐标同系）。

内置纪律与合规边界：

- 串行限速、结果缓存（路线 5 分钟）、单次生成调用上限、全站预算；高德按服务在实际请求前持久化原子扣减，超出自动降级
- 任一数据源缺失/超额**不影响生成**：自动降级为「仅高德」「仅搜索」或纯模型知识调研，行程会标注实际所用数据源
- 遵守高德服务协议：地点图片仅**热链实时展示、不转存文件**；候选落库只保留名称、短摘要与来源链接；请勿改造为批量采集工具
- 预约信息为搜索抽取 + 种子表，**以官方渠道为准**（卡片附来源链接与免责提示）

---

## 图片存储（可选：对象存储 + CDN）

默认图片落在宿主机 `./data/media`，由容器**只读挂载**并在 `/media/` 下托管 —— 图片不随镜像发布，首次部署或上游重导后需自行同步（`rsync -a --delete data/media/ user@host:/path/to/deploy/data/media/`）。

想免掉这一步、并让线上运行时缓存的新图（Pexels / 维基）能真正落盘，可改用 S3 兼容对象存储（以 Cloudflare R2 为例）：

```bash
# .env
MEDIA_STORE=s3
MEDIA_S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
MEDIA_S3_BUCKET=rollinggo-trip-media
MEDIA_S3_ACCESS_KEY_ID=...
MEDIA_S3_SECRET_ACCESS_KEY=...
MEDIA_BASE_URL=https://media.example.com/media   # R2 自定义域名映射桶根，/media 是 key 的一部分
```

在有仓库的机器上先迁移再切换（镜像部署的机器没有 `tsx`；预演不写入，`--apply` 才上传）：

```bash
node --import tsx apps/server/scripts/migrate-media-to-s3.mts
node --import tsx apps/server/scripts/migrate-media-to-s3.mts --apply
```

迁移是幂等的（比对象 ETag 与本地文件 md5，一致则跳过），本地与线上各跑一遍即可补齐各自新增的文件。切换后宿主机 `data/` 不再被读写，建议**保留**作为回滚点：把 `MEDIA_STORE` 改回 `local` 并同步回目录即恢复。历史行程快照里的 `/media/...` 路径不需要改写。

`MEDIA_BASE_URL` 同时决定海报成品的域名（海报也是内容寻址，库里只存文件名，换前缀不用动数据库）。海报走 CDN 后，浏览器点「下载」需要读跨域字节，所以桶要配一条 CORS 规则：`origins: ["*"]`、`methods: ["GET","HEAD"]`（图片本来就公开可读、请求不带凭据）。没配 CORS 时前端会自动退回同源 `/media/...`（服务端从同一个桶转发），功能不受影响；微信里「长按保存」走的是 `<img>`，不受影响。

看用量（只读、不清理）：

```bash
node --import tsx apps/server/scripts/migrate-media-to-s3.mts --report
```

没有任何自动过期策略：唯一会被删的是「同一行程同一风格被替换掉的旧海报」。`media/remote-photos` 与 `photo-store/**` 只增不减，到接近免费额度时再考虑清理。

---

## GitHub 登录（可选）

1. 到 GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App（不是 GitHub App）；
2. Authorization callback URL 填 `<APP_BASE_URL>/api/auth/github/callback`（OAuth App 只允许一个 callback，**本地开发请另注册一个 App**，callback 填 `http://localhost:5173/api/auth/github/callback`）；
3. 把 Client ID / Client Secret 与 `APP_BASE_URL` 写入 `.env` 并重启。

登录只申请 `user:email` 权限，access token 拉取一次身份后即丢弃、不落库；GitHub 已验证邮箱与站内账号相同时自动绑定。`invite`/`closed` 模式下 GitHub 仅允许既有用户登录，不允许创建新账号。

---

## 推荐模型量级

三 Agent 流水线依赖**可靠的多轮工具调用**。推荐 `deepseek-chat`、`gpt-4o-mini`、`glm-4-air` 及以上量级；小参数本地模型（<7B）容易在工具调用上反复失败——系统有轮次熔断与完整性校验兜底，但体验会明显变差。

## 成本估算

- 地图 / 地理编码：OSM 与开源社区部分**零费用**；高德与 LangSearch 免费额度内**近零成本**（单次生成约 3–6 次高德 + 4–8 次搜索调用）
- 天气：和风天气免费档每月 5 万次请求（单次生成每目的地最多 2 次），远超个人站点用量
- LLM：一次生成约 5–15 万 token；以 DeepSeek 计约每次几分到一两毛钱
- 成本三道闸：注册管控（默认开放，可切 `invite` 模式挡陌生人）、每日配额（生成与对话分别限次）、用量落库（`generations` 表可审计，含数据源调用数）
- 用户在高级设置里配置自己的 Key（BYOK）后，其生成不消耗站点 Key

## 安全设计

密码 bcrypt 哈希；LLM、高德与个人搜索 API Key 均以 AES-256-GCM 加密存储、任何接口不回显明文；httpOnly Cookie 会话；登录/注册限流；用户提供的 LLM 与搜索 Base URL 保存和使用时双重 SSRF 校验；用户数据严格隔离。详见[架构文档 §9](TECHNICAL_ARCHITECTURE.md)。
