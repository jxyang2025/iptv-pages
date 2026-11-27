# iPTV —— Cloudflare Worker + KV 全托管版

把 [akiralereal/iptv](https://github.com/akiralereal/iptv) 的管理页与播放器拆出来，托管到 Cloudflare。**不依赖任何 Docker 后端**：订阅源、频道、配置全部存在 Cloudflare KV，Worker 自己抓取订阅 URL、解析 M3U/TXT、生成播放列表。前端 `web/` 零改动。

线上地址：`https://iptv-pages.jxy5460.workers.dev`

## 架构

```
管理端 ──HTTPS──> Cloudflare Worker (src/index.js)
                    ├─ /admin.html /player.html /图标 /播放器库  →  ASSETS 静态资源
                    ├─ /api/*                                   →  Worker 内置 API
                    │     ├─ 订阅源 CRUD / 导入订阅 / 配置读写    →  KV 读写
                    │     └─ /api/auto-refresh                  →  查看/改频率/立即刷新
                    ├─ /m3u  /interface.m3u  /txt                →  从 KV 输出播放列表
                    └─ /playback.xml                            →  空 EPG 占位

Cron Trigger ─每整点─> scheduled() → 按间隔拉取订阅 → 重建频道/M3U → KV
```

对比旧方案（反代到 Docker + Tunnel）：本方案**没有源站、不开端口、不用 Tunnel、不用常驻进程**，全部跑在 Cloudflare 免费额度内。

### 功能边界（重要）

| 能力 | 状态 | 说明 |
|---|---|---|
| 添加/编辑/删除订阅源 | ✅ | 在线 URL 抓取 + 本地粘贴/文件导入 |
| 定时自动刷新订阅 | ✅ | Cloudflare Cron 每整点检查，默认每 24 小时拉取一次并重建列表；频率可调 |
| M3U / TXT(diyp) 解析 | ✅ | 复刻上游解析逻辑（group-title / tvg-id / logo / EXTVLCOPT / 回看） |
| 关键字自动分组 | ✅ | 按频道名关键字把「未分组」频道归类；首条命中胜、刷新不丢、存 KV |
| 组名智能合并 | ✅ | 不同源的同义组名（央视频/央视/CCTV/📺央视频道…）自动归一为一个组，可自定义别名 |
| 全局 URL 去重 | ✅ | 不同订阅源里相同播放 URL 只保留一条，并合并来源徽标 |
| 生成播放列表 `/m3u` | ✅ | 保存/导入/改分组规则后自动重建 |
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
├── wrangler.toml                 # Workers + Assets + KV + Cron 绑定配置
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
| `auto-refresh` | 定时刷新配置 `{enabled,intervalHours,lastRunAt,lastResult}` |
| `auto-refresh-lock` | 定时任务防重入锁（带 TTL，自动过期） |
| `group-keyword-rules` | 关键字自动分组规则 `[{group, keywords:[]}]` |
| `group-alias` | 组名合并别名 `[{from,to}]`（智能归一之外手动补充） |

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

## 定时自动刷新

Worker 注册了 Cloudflare Cron Trigger，**每小时整点（UTC，也就是北京时间每小时整点）**执行一次检查；真正拉取订阅的间隔由 KV 配置控制，默认 **24 小时**。因此不需要本地电脑、Docker 或 WorkBuddy 定时 task 常开。

工作机制：

1. 到点后读取 `auto-refresh` 配置；未到 `intervalHours` 则直接跳过，不消耗订阅请求。
2. 到点则遍历 `ext-config.sources` 中所有「订阅模式 + 有订阅地址 + 未禁用 + 非本地粘贴」的源，逐条重新抓取、解析、更新 `parsedChannels`。
3. 单条源失败只写 `fetchStatus`，**保留上一次成功的频道**，不会把播放列表清空。
4. 全部处理完统一重建 `channels` 与 `playlist-m3u`，并写入 `lastRunAt` / `lastResult`。
5. KV 锁 `auto-refresh-lock` 防止上一轮没跑完时重复执行。

前端管理页没有加新按钮，直接用 API 查看/改频率（若设置了 `ADMIN_PASS`，额外加 `-H 'X-Admin-Pass: <口令>'`）：

```bash
BASE=https://iptv-pages.jxy5460.workers.dev

# 查看当前配置与上次运行结果
curl "$BASE/api/auto-refresh"

# 改成每 6 小时刷新一次（intervalHours 可取 1~720）
curl -X POST "$BASE/api/auto-refresh" \
  -H 'Content-Type: application/json' \
  -d '{"intervalHours":6}'

# 关闭 / 重新开启自动刷新
curl -X POST "$BASE/api/auto-refresh" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}'

curl -X POST "$BASE/api/auto-refresh" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}'

# 不等定时，立即强制刷新一次
curl -X POST "$BASE/api/auto-refresh" \
  -H 'Content-Type: application/json' \
  -d '{"action":"run"}'
```

> 改 `wrangler.toml` 里的 `crons` 只能改「检查频率」；改「实际拉取间隔」请用上面的 `/api/auto-refresh`。

## 关键字自动分组（怎么工作）

管理页「设置 → 自动分组」里配的规则，保存在 KV 的 `group-keyword-rules`，格式 `[{group, keywords:[]}]`。生效时机与范围：

- **只对「未分组」频道生效**。频道若已被订阅源自带分组（`group-title`）归好类，或由源的「默认分组」归类，规则不会动它；想让某源全部按规则重排，勾选该源的「忽略源自带分组」（未命中规则的进该源默认分组）。
- **首条命中胜**：多条规则按列表从上到下匹配，频道名包含任一关键字（大小写不敏感、子串匹配）即归入该规则的目标组，后面的规则不再匹配。用规则行上的 ↑/↓ 调整优先级。
- **保存即生效**：规则落库后会立刻从订阅原始数据重建 `channels` 与 `/m3u`，无需重新导入订阅；定时刷新（Cron）重建时也会套用最新规则，所以"刷新也不丢"。

API（前端就是调这两个）：

```bash
BASE=https://iptv-pages.jxy5460.workers.dev
curl "$BASE/api/group-keyword-rules"                                    # 查看规则
curl -X POST "$BASE/api/group-keyword-rules" -H 'Content-Type: application/json' \
  -d '{"action":"setRule","group":"央视","keywords":"CCTV,央视视频,央视频道"}'
# action 还支持 moveRule（配 group + direction:up/down）、removeRule（配 group）
```

> 这是"按频道名字归类到目标组"。若要合并**已经存在的多个组名**（如「央视频」「央视」「CCTV」三组合成一组），见下一节「组名智能合并」。

## 组名智能合并（同义组名归一）

不同订阅源给同一类频道起的组名往往不一样，例如央视频道可能分散在「央视频」「央视」「CCTV」「央视频道」「📺央视频道」「💰央视付费频道」多个组里。Worker 会在**重建频道和读取播放列表时**自动把这些同义组名归一为一个组（统一显示为「央视」），前端只看到一组。

归一规则（按优先级）：

1. **内置精确别名**：`央视频 / CCTV / 中央电视台 / 中央台 / 央视网` → `央视`。
2. **签名匹配**：组名转小写 → 去掉 emoji 和符号（如 `📺`、`💰`）→ 剥离尾部修饰词（`频道/视频/高清/付费/网/台` 等）→ 命中同义词表。所以 `📺央视频道`、`💰央视付费频道`、`CCTV高清频道` 都会归到「央视」。
3. **未命中则原样保留**，避免过度合并。

这套逻辑同时作用于：保存/导入订阅、改分组规则、定时刷新重建、以及读取 `/api/channels`、`/api/my-playlist`，因此**旧数据刷新页面就即时生效**，无需重新导入。合并后同组里相同播放 URL 的频道仍会按全局 URL 去重。

若内置规则不够（比如想把某两个自定义组合并），可用自定义别名 API：

```bash
BASE=https://iptv-pages.jxy5460.workers.dev
curl "$BASE/api/group-alias"                                          # 查看别名
curl -X POST "$BASE/api/group-alias" -H 'Content-Type: application/json' \
  -d '{"action":"set","from":"凤凰卫视","to":"卫视"}'
curl -X POST "$BASE/api/group-alias" -H 'Content-Type: application/json' \
  -d '{"action":"remove","from":"凤凰卫视"}'
# action 还支持 clear（清空）、rebuild（仅重建不改动）
```

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
5. **定时刷新频率**：免费版每个账号最多 5 个 Cron Trigger，本项目只用 1 个；单次 Cron 的 CPU 上限为 10 ms，若订阅源超大（上万频道）可能超限，建议拆分成多个源或调大刷新间隔。刷新失败不会清空已有频道。

## 升级前端

上游发版后：

```bash
node scripts/sync-web.mjs
npx wrangler deploy
```

只需覆盖 `web/`，`src/index.js` 的 API 实现不受影响。
