# iPTV —— Cloudflare Worker + KV 全托管版

把 [akiralereal/iptv](https://github.com/akiralereal/iptv) 的管理页与播放器拆出来，托管到 Cloudflare。**不依赖任何 Docker 后端**：订阅源、频道、配置全部存在 Cloudflare KV，Worker 自己抓取订阅 URL、解析 M3U/TXT、生成播放列表。前端 `web/` 零改动。

线上地址：`https://iptv-pages.jxy5460.workers.dev`

## 架构

```
管理端 ──HTTPS──> Cloudflare Worker (src/index.js)
                    ├─ /admin.html /player.html /图标 /播放器库  →  ASSETS 静态资源
                    ├─ /api/*                                   →  Worker 内置 API
                    │     └─ 订阅源 CRUD / 导入订阅 / 配置读写    →  KV 读写
                    ├─ /m3u  /interface.m3u  /txt                →  从 KV 输出播放列表
                    └─ /playback.xml                            →  空 EPG 占位
```

对比旧方案（反代到 Docker + Tunnel）：本方案**没有源站、不开端口、不用 Tunnel、不用常驻进程**，全部跑在 Cloudflare 免费额度内。

### 功能边界（重要）

| 能力 | 状态 | 说明 |
|---|---|---|
| 添加/编辑/删除订阅源 | ✅ | 在线 URL 抓取 + 本地粘贴/文件导入 |
| M3U / TXT(diyp) 解析 | ✅ | 复刻上游解析逻辑（group-title / tvg-id / logo / EXTVLCOPT / 回看） |
| 生成播放列表 `/m3u` | ✅ | 保存/导入后自动重建 |
| 系统配置保存 | ✅ | 存 KV |
| 我的频道（隐藏/分组/改名） | ✅ | 存 KV |
| EPG / 台标托管 / 用户令牌 / 直播抓取模块 | ⚠️ 占位 | 返回空结构，页面可用但不产生数据（Workers 无原生进程/浏览器） |
| 咪咕/央视频等需浏览器登录的源 | ❌ | 需在原 Docker 后端使用 |

> 一句话：**纯订阅聚合分发**完全可用；需要爬虫登录的频道源请留在原 Docker 项目。

## 目录结构

```
.
├── web/                          # 从上游原样复制的前端，零改动
│   ├── admin.html                # 管理后台单页（861 KB）
│   ├── player.html               # 播放器页
│   ├── icons/                    # 品牌图标
│   └── vendor/                   # hls.js / mpegts.js / DPlayer
├── src/
│   └── index.js                  # Worker 全栈入口：内置 API + KV 存储 + M3U 解析/生成 + 静态托管
├── scripts/
│   ├── sync-web.mjs              # 一键同步上游前端
│   └── legacy-config/            # 旧版 _redirects/_headers 存档（Workers 模式不用）
├── wrangler.toml                 # Workers + Assets + KV 绑定配置
├── .dev.vars.example             # 可选管理员口令模板
├── LICENSE                       # 上游 GPL-3.0 许可证
└── README.md                     # 本文档
```

## KV 数据结构

| KV 键 | 内容 |
|---|---|
| `ext-config` | 整份外部源配置 `{enabled, sources:[...], fetchStatus, proxy}` |
| `channels` | 频道分组 `[{name, dataList:[...]}]` |
| `sys-config` | 系统配置 |
| `built-in` | 内置源配置 |
| `playlist-config` | 我的频道配置（隐藏/分组/改名等） |
| `playlist-m3u` | 生成的 M3U 纯文本 |

## 部署步骤

### 首次部署（已完成，供重建参考）

```bash
# 1. 创建 KV（如已存在可跳过）
npx wrangler kv namespace create IPTV_KV
npx wrangler kv namespace create IPTV_KV --preview
# 把返回的 id / preview_id 填进 wrangler.toml

# 2. 本地调试
npx wrangler dev --local

# 3. 部署
npx wrangler deploy
```

Cloudflare 控制台新建项目时（新版向导）：
| 字段 | 值 |
|---|---|
| Framework preset | None |
| Build command | `exit 0` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |

静态目录由 `wrangler.toml` 的 `[assets] directory = "./web"` 声明。

### 日常更新

```bash
git push origin main          # 代码备份（Git 集成可能未自动部署，以本地 deploy 为准）
npx wrangler deploy           # 真正上线
```

## 使用方法

1. 打开 `https://iptv-pages.jxy5460.workers.dev`，自动进入管理页 `/admin`。
2. 「自定义源」标签 → 添加自定义源 → 选**订阅模式** → 填订阅地址（或本地粘贴/上传文件）。
3. 点**导入并保存**：Worker 抓取订阅、解析频道、写入 KV、自动生成播放列表。
4. 顶部订阅地址栏即为播放列表地址（`/m3u`），复制到播放器即可。

## 可选：管理页口令

默认任何人可访问管理页并修改配置。如需口令：

1. Cloudflare 控制台 → 项目 → Settings → Environment variables → 添加 `ADMIN_PASS`（Secret）。
2. 设置后，写操作（POST）需在请求头带 `X-Admin-Pass: <口令>` 或 `Authorization: Bearer <口令>`。
3. ⚠️ 前端页面本身不改请求头，所以设置口令后前端的保存操作会 403。如需口令保护，建议改用 Cloudflare Access 在网关层做鉴权（对项目整体保护），而不是用 `ADMIN_PASS`。

## 已知限制

1. **地域性**：Worker 从 Cloudflare 边缘节点出网抓取订阅。若订阅源只放行大陆 IP（如部分国内源），抓取可能失败——这类源请留在本地 Docker 后端。
2. **KV 最终一致性**：保存/导入后立即回读可能拿到稍旧的值（通常同区域秒级）。前端主要依赖本地内存状态，一般无感。
3. **抓取超时**：Worker 单次请求有 CPU/时间限制，`fetchTimeout` 建议 ≤ 25 秒；超大订阅（上万频道）可能超限。
4. **EPG**：`/playback.xml` 返回空结构，播放器无节目单。
5. **无定时刷新**：Worker 无常驻定时器，订阅不会自动更新——需要时到管理页点「导入并保存」手动刷新，或后续接入 Cloudflare Cron Trigger。

## 升级前端

上游发版后：

```bash
node scripts/sync-web.mjs
npx wrangler deploy
```

只需覆盖 `web/`，`src/index.js` 的 API 实现不受影响。
