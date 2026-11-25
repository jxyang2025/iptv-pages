# iPTV 的 Cloudflare Pages 前端

把 [akiralereal/iptv](https://github.com/akiralereal/iptv) 的管理页与播放器拆出来，托管到 Cloudflare Pages；后端抓取核心继续跑在 Docker / NAS 上，通过 Cloudflare Tunnel 暴露，由 Pages Functions 做同域反代。

## 为什么是「前端上云、核心留本地」

原项目是一个 7×24 常驻的 Node.js 服务，依赖 Chromium（Puppeteer 抓取）、ffmpeg、Python yt-dlp、以及 `/iptv/data` 持久化卷。Cloudflare Workers / Pages 是请求触发的无状态运行时，跑不了原生进程、也没有持久文件系统——**整体直搬不可行**。所以只把纯静态的 `web/` 搬上 Pages，动态请求反代回源站：

```
观众/管理端 ──HTTPS──> Cloudflare Pages
                         ├─ /admin.html、/player.html、图标、播放器库  →  Pages 静态文件
                         ├─ /api/*                                   →  Pages Function ─┐
                         └─ /m3u、/u/*、/playback.xml、/logos/*        →  Pages Function ─┤
                                                                                        │
                                                     Cloudflare Tunnel（加密、不暴露端口）│
                                                                                        ▼
                                                                      NAS / VPS 上的 Docker 后端
                                                                      （app.js + Chromium + ffmpeg + 数据卷）
```

这样做的好处：前端拿到全球 CDN 加速和免费 HTTPS；源站不暴露公网 IP、不开端口；管理 API 的同源鉴权逻辑原样保留，不用改一行业务代码。

## 目录结构

```
.
├── web/                          # 从上游原样复制的前端，零改动
│   ├── admin.html                # 管理后台单页（861 KB）
│   ├── player.html               # 播放器页
│   ├── icons/                    # 品牌图标
│   ├── vendor/                   # hls.js / mpegts.js / DPlayer（播放器库）
│   ├── _redirects                # 路径映射（保留存档；Workers 模式下由 src/index.js 实现）
│   └── _headers                  # 缓存与安全响应头（同上）
├── src/
│   └── index.js                  # Worker 入口：API/订阅反代 + 静态重写 + 安全头
├── wrangler.toml                 # Workers + Assets 配置（新版向导用）
├── .dev.vars.example             # 本地调试环境变量模板
├── scripts/sync-web.mjs          # 一键同步上游前端
└── LICENSE                       # 上游 GPL-3.0 许可证
```

## 部署步骤

### 第 1 步：源站准备（保持原有 Docker 部署不变）

1. 上游容器照常运行，`docker compose pull && docker compose up -d`。
2. 记下系统配置里的**访问密码**（没有就留空，但建议设置一个）。
3. 确认本机已装好 `cloudflared` 并登录了你的 Cloudflare 账号。

### 第 2 步：建立 Cloudflare Tunnel

在 NAS / VPS 上执行（或用 Docker 版 cloudflared）：

```bash
cloudflared tunnel login
cloudflared tunnel create iptv-backend
cloudflared tunnel route dns iptv-backend iptv.example.com
cloudflared tunnel run iptv-backend --url http://127.0.0.1:8888
```

把 `http://127.0.0.1:8888` 换成你上游容器实际监听的地址。Tunnel 域名（如 `iptv.example.com`）就是后面要填的 `BACKEND_ORIGIN`。

> 源站不需要在路由器开任何端口，Cloudflare 通过出站隧道连过来。

### 第 3 步：部署 Pages

方式 A —— 控制台拖拽（最快）：

1. Cloudflare 仪表盘 → **Workers & Pages** → **Create** → **Pages** → **Upload assets**。
2. 项目名填 `iptv-pages`，上传整个 `web/` **目录里的内容**（不是 web 文件夹本身）。
3. 上传后在项目的 **Functions** 配置里，把 `functions/` 目录的文件作为函数上传；如果用 Git 连接部署， Functions 会自动识别。

方式 B —— Git 连接（推荐，后续升级方便）：

```bash
# 把本项目推到你的 GitHub 仓库，然后在 Pages 里 Connect to Git
git init
git add .
git commit -m "iPTV Pages frontend"
git remote add origin https://github.com/你的账号/iptv-pages.git
git push -u origin main
```

在 Pages 创建页选择该仓库，构建设置（适配 **2026 新版向导**，它强制要求填 Deploy command）：

| 配置项 | 值 |
|---|---|
| Framework preset | **None / 无** |
| Build command | `exit 0`（无需构建，空操作即可） |
| Deploy command | `npx wrangler deploy` |
| Root directory | 留空 `/` |

> 📌 **为什么这样填**：2026 年 Cloudflare 已把 Pages 并入 Workers 体系，新版向导强制要求 Deploy command，且静态目录改由仓库根目录的 `wrangler.toml` 里 `[assets] directory = "./web"` 声明，`main = "src/index.js"` 是 Worker 反代入口。
> 本项目已按此模式配置好，直接按上表填即可。旧版的 `Build output directory` / `Functions directory` 字段在新向导里不再需要。
>
> 常见报错：`Missing entry-point to Worker script or to assets directory` —— 多半是 `wrangler.toml` 没被读到，确认它在仓库根目录、且含 `main` 与 `[assets]` 两段。

### 第 4 步：配置环境变量

进入 Pages 项目 → **Settings** → **Environment variables**，为 **Production**（和 Preview，如需要）各添加：

| 变量名 | 必填 | 示例值 | 说明 |
|---|---|---|---|
| `BACKEND_ORIGIN` | 是 | `https://iptv.example.com` | Tunnel 域名，结尾不要带 `/` |
| `BACKEND_PASS` | 否 | `mypassword` | 上游系统配置里的访问密码；没设就留空 |
| `BACKEND_PREFIX` | 否 | `/iptv` | 若 Tunnel 后面还挂了一层反代子路径才需要填 |

改完环境变量需要 **Redeploy** 才生效。

### 第 5 步：验证

打开 `https://你的Pages域名.pages.dev`：

- 自动跳转到 `/admin.html`，管理后台正常显示 → 静态资源 OK
- 频道列表能加载出来 → `/api/*` 反代 + 密码鉴权 OK
- 后台「我的频道」里复制的订阅地址（`.../m3u`、`.../u/<token>/...`）能放进播放器播放 → catch-all 反代 OK
- 播放器页 `/player.html` 能加载 hls.js / mpegts.js → `_redirects` 映射 OK

## 本地调试

```bash
cp .dev.vars.example .dev.vars   # 填好后端地址
npx wrangler dev                 # Workers + Assets 模式，读 wrangler.toml
```

打开终端显示的本地地址即可。注意 `.dev.vars` 已加入 `.gitignore`，不会被提交。

## 已知限制与注意事项（重要）

1. **视频流不走 Pages**。M3U 里的频道直链由上游后端生成，仍指向源站/Tunnel；播放器拉流是直接连源站的，不会经过 Worker。只有「全代理版」订阅（`relay=2`，分片也过服务器转发）的流量会经过 Tunnel，会占用 Cloudflare 的出站流量与 Workers 请求额度，个人用建议用兼容版或默认版。
2. **Workers 请求额度**。反代 Worker 按请求数计费（免费额度有限）。管理后台每次操作都会发 API 请求，但正常家用量远低于免费额度；若有大量用户高频拉订阅，建议把订阅地址直接指向 Tunnel 域名，绕过 Pages。
3. **地域限制仍在**。上游很多模块依赖大陆网络抓取（README 里标注「仅大陆」，境外 IP 会被 405）。Tunnel 只是加密通道，不改变后端所在网络的地域属性——所以后端必须放在大陆网络环境里，放海外 VPS 会导致大量频道抓取失败。
4. **合规**。上游项目自带版权免责声明，请仅在合法授权范围内个人使用，不要公开分发转播。
5. **升级前端**。上游发版后，只需重新下载 `web/` 里的 `admin.html`、`player.html`、`icons/`、`vendor/` 覆盖本项目的 `web/` 同名文件即可——`_redirects` 和 `_headers` 是我们加的，不要删。`src/index.js` 与 `wrangler.toml` 无需改动。

## 同步上游前端脚本

在项目根目录执行，可一键重新拉取上游 `web/`（会保留本项目的 `_redirects` / `_headers`）：

```bash
node scripts/sync-web.mjs
```
