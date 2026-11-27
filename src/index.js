/**
 * iPTV —— Cloudflare Worker + KV 全托管版（无 Docker 后端）
 *
 * 订阅源、频道、配置全部存 KV；Worker 自己抓取订阅 URL、解析 M3U/TXT、
 * 生成播放列表。前端 web/admin.html 零改动，直接调用同源 /api/*。
 *
 * KV 键：
 *   ext-config      整份外部源配置  {enabled,includeInPlaylists,sources:[...],...}
 *   channels        频道分组数组    [{name,dataList:[...]}]
 *   sys-config      系统配置
 *   built-in        内置源配置
 *   playlist-config 我的频道配置
 *   playlist-m3u    生成的 M3U 文本
 *   auto-refresh    定时刷新配置与上次执行结果
 *   auto-refresh-lock 定时任务防重入锁（带 TTL，自动过期）
 *   group-keyword-rules 关键字自动分组规则 [{group, keywords:[]}]，顺序即优先级
 *   group-alias      组名归一化别名 [{from,to}]，智能合并同义组名之外的手动补充
 *   其余小配置各占一键（aliases/epg/notify/users/extractors/...）
 */

const JSON_HEADERS = { 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store' };
const TEXT_HEADERS = { 'Content-Type': 'text/plain;charset=UTF-8' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
const ok = (data, extra = {}) => json({ success: true, data, ...extra });
const fail = (message, status = 200) => json({ success: false, message }, status);

// ---------- KV 读写助手 ----------
const kvGet = async (env, key, fallback) => {
  try {
    const v = await env.IPTV_KV.get(key, 'text');
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
};
const kvPut = (env, key, val) => env.IPTV_KV.put(key, JSON.stringify(val));

// ---------- 组名智能归一化（合并同义组名）----------
// 场景：不同订阅源对同一类频道用了不同组名（央视频 / 央视 / CCTV），
// 目标：智能识别为同一组，前端只显示一个组名，不再显示三组。
// 做法：组名先算「签名」（小写、去空白/分隔符、循环剥离尾部通用修饰词），
// 再用「内置同义词表 + 用户自定义别名」映射到统一显示名。
const GROUP_ALIAS_KEY = 'group-alias';

// 尾部通用修饰词：不区分组，剥离后得到组名签名。长的在前；循环可处理叠加（如「央视高清频道」）。
const GROUP_NAME_SUFFIXES = [
  '高清', '超清', '蓝光', 'uhd', '4k', 'hd', 'vip',
  '付费', '精选', '频道', '视频', '网', '台',
];

// 内置同义词表：key 是签名，value 是统一显示名。
// 央视三写法：央视频→签名「央视」、央视→「央视」、CCTV→「cctv」，两者均映射到「央视」。
const BUILTIN_GROUP_CANON = {
  cctv: '央视',
  央视: '央视',
  中央电视: '央视', // 中央电视台 → 去「台」→ 中央电视
  央视国际: '央视',
  卫视: '卫视',
  电影: '电影',
  电视剧: '电视剧',
  体育: '体育',
  新闻: '新闻',
  少儿: '少儿',
  儿童: '少儿',
  纪录: '纪录片',
  纪录片: '纪录片',
  港澳: '港澳台',
  港台: '港澳台',
  港澳台: '港澳台',
  地方: '地方',
};

// 已知省市地区名：用于判断「浙江卫视」「江苏IPTV」里的前缀是否为地区。
// 作用：只在这些地区名下才剥离「卫视/IPTV」等后缀，避免把「凤凰卫视」这类品牌误剥成「凤凰」。
const KNOWN_REGIONS = new Set([
  '北京','上海','天津','重庆','河北','山西','辽宁','吉林','黑龙江','江苏','浙江','安徽',
  '福建','江西','山东','河南','湖北','湖南','广东','海南','四川','贵州','云南','陕西',
  '甘肃','青海','台湾','内蒙古','广西','西藏','宁夏','新疆','香港','澳门',
  '深圳','广州','杭州','南京','成都','武汉','西安','苏州','青岛','大连','宁波','厦门',
  '长沙','郑州','济南','福州','合肥','南昌','昆明','贵阳','南宁','海口','太原','石家庄',
  '哈尔滨','长春','沈阳','兰州','西宁','银川','乌鲁木齐','拉萨','呼和浩特',
]);

// 条件后缀：仅当剥离后的核心名是已知地区时才应用，防止误伤品牌名。
const CONDITIONAL_SUFFIXES = ['卫视', 'iptv', '网络', '专区'];

// 内置精确别名：整串匹配（小写），优先于签名归一化。
// 「央视频」若按词尾剥离「视频」会变成「央」，故必须精确拦截这类写法。
const BUILTIN_GROUP_ALIASES = {
  央视频: '央视',
  cctv: '央视',
  cctv视频: '央视',
  中央电视台: '央视',
  中央台: '央视',
  央视网: '央视',
  cctv网: '央视',
};

// 组名核心提取：去掉 emoji/符号前缀、循环剥离尾部修饰词，但保留原文的大小写与汉字。
// 用于生成"通用归一显示名"：☘️北京频道 / 北京频道 / 北京 → 北京，所有省份、地区、主题组通用。
// 与 groupNameSignature 的区别：后者全小写，仅用于查表；本函数产出实际显示给用户的组名。
function groupNameCore(name) {
  let s = String(name == null ? '' : name).trim().replace(/^[^\p{L}\p{N}]+/u, '');
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 8) {
    changed = false;
    for (const suf of GROUP_NAME_SUFFIXES) {
      // 中文修饰词直接匹配；英文修饰词（hd/4k/vip…）大小写不敏感
      const hit = s.endsWith(suf) || s.toLowerCase().endsWith(suf.toLowerCase());
      if (hit && s.length > suf.length) {
        s = s.slice(0, -suf.length);
        changed = true;
        break;
      }
    }
  }
  // 条件后缀（卫视/IPTV/网络/专区）：仅当剥离后核心名是已知省市地区时才应用，
  // 这样「浙江卫视」→「浙江」，而「凤凰卫视」保持原样不被误剥。
  for (const suf of CONDITIONAL_SUFFIXES) {
    if (s.length > suf.length && s.toLowerCase().endsWith(suf.toLowerCase())) {
      const candidate = s.slice(0, -suf.length).trim();
      if (KNOWN_REGIONS.has(candidate)) { s = candidate; break; }
    }
  }
  return s.trim();
}

// 组名签名：小写、去掉所有 emoji/符号/空白（只留字母数字汉字）、循环剥离尾部修饰词。
// 用于查表与比较键，比 groupNameCore 更激进（连内部符号也去掉），例如 CCTV-5 → cctv5。
function groupNameSignature(name) {
  const core = groupNameCore(name).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  // 去掉内部符号后可能重新暴露尾部修饰词，再剥一次
  let s = core;
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 8) {
    changed = false;
    for (const suf of GROUP_NAME_SUFFIXES) {
      if (s.length > suf.length && s.endsWith(suf)) {
        s = s.slice(0, -suf.length);
        changed = true;
        break;
      }
    }
  }
  return s;
}

// 读取用户自定义别名。KV 存 [{from,to}]，返回 { exact:{原名小写→目标}, sig:{签名→目标} }。
// exact 优先，避免「央视频」的自定义别名误伤「央视」（二者签名相同）。
async function loadGroupAliases(env) {
  const raw = await kvGet(env, GROUP_ALIAS_KEY, []);
  const exact = {};
  const sig = {};
  if (!Array.isArray(raw)) return { exact, sig };
  for (const r of raw) {
    const from = String(r?.from || '').trim();
    const to = String(r?.to || '').trim();
    if (!from || !to) continue;
    exact[from.toLowerCase()] = to;
    const s = groupNameSignature(from);
    if (s) sig[s] = to;
  }
  return { exact, sig };
}

// 把任意组名归一化为统一显示名；未命中任何规则时保持原名（保守，避免误合并）。
function canonicalGroupName(name, aliases = null) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return '未分组';
  if (raw === '未分组') return raw;
  const lower = raw.toLowerCase();
  const cleaned = lower.replace(/[^\p{L}\p{N}]/gu, ''); // 去 emoji/符号后再查内置精确表
  if (aliases && aliases.exact && Object.prototype.hasOwnProperty.call(aliases.exact, lower)) {
    return aliases.exact[lower];
  }
  if (aliases && aliases.exact && cleaned !== lower
      && Object.prototype.hasOwnProperty.call(aliases.exact, cleaned)) {
    return aliases.exact[cleaned];
  }
  if (Object.prototype.hasOwnProperty.call(BUILTIN_GROUP_ALIASES, cleaned)) {
    return BUILTIN_GROUP_ALIASES[cleaned];
  }
  const sig = groupNameSignature(raw);
  if (!sig) return raw;
  if (aliases && aliases.sig && Object.prototype.hasOwnProperty.call(aliases.sig, sig)) {
    return aliases.sig[sig];
  }
  if (Object.prototype.hasOwnProperty.call(BUILTIN_GROUP_CANON, sig)) {
    return BUILTIN_GROUP_CANON[sig];
  }
  // 通用归一（举一反三）：未命中任何表时，剥离 emoji 前缀与尾部修饰词，用核心名作统一组名。
  // 例：☘️北京频道 / 北京频道 / 北京 → 北京；🌸上海高清 / 上海频道 → 上海。
  // 只有核心名非空时才发现作用；纯 emoji / 纯修饰词的组名保持原样，避免误合并。
  const core = groupNameCore(raw);
  return core || raw;
}

// 全局按播放 URL 去重（跨来源）：同一 url 只保留先入者，把后续来源并入 sourceIds。
// 说明：上游原版是「组内 + 名字+地址」去重；本项目为多订阅源场景，按用户诉求改为
// 「全局 + URL」去重——不同源的同一频道 url 常落在不同分组名，组内去重无法覆盖。
// 同名不同地址的线路不合并（互为备份），仅 url 相同才算重复。
// 合并 sourceIds 可让前端「N源」徽标与按档禁用逻辑保持正确。
function dedupeByUrl(groups) {
  const byUrl = new Map();
  const out = [];
  for (const g of (Array.isArray(groups) ? groups : [])) {
    const list = Array.isArray(g.channels) ? g.channels
      : (Array.isArray(g.dataList) ? g.dataList : []);
    const kept = [];
    for (const ch of list) {
      const key = String((ch && ch.url) || '').trim();
      if (!key) { kept.push(ch); continue; } // 无 url 的条目不去重
      const prev = byUrl.get(key);
      if (prev) {
        // 同 url：把后来来源并入保留者的 sourceIds，然后丢弃重复条目
        if (!Array.isArray(prev.sourceIds)) prev.sourceIds = [];
        const add = []
          .concat(prev.sourceId ? [prev.sourceId] : [])
          .concat(Array.isArray(ch.sourceIds) ? ch.sourceIds : [])
          .concat(ch.sourceId ? [ch.sourceId] : []);
        for (const sid of add) if (sid && !prev.sourceIds.includes(sid)) prev.sourceIds.push(sid);
        continue;
      }
      byUrl.set(key, ch);
      kept.push(ch);
    }
    out.push({ ...g, channels: kept, dataList: kept });
  }
  return out;
}

// 前端有两套字段约定：/api/channels 用 dataList，/api/my-playlist 用 channels。
// 同一份分组数据必须两个字段都带，且指向同一数组，否则 renderGroupLists() 里
// group.channels.length 会对 undefined 取 length 抛 TypeError（表现为"加载我的频道失败"）。
// 同时在此统一做 URL 去重，使读取旧数据也即时生效（无需用户重新导入订阅）。
function normalizeGroups(groups, aliases = null) {
  // 先按归一化组名合并：不同源的「央视频 / 央视 / CCTV」归到同一个组名。
  const merged = new Map();
  for (const g of (Array.isArray(groups) ? groups : [])) {
    const list = Array.isArray(g.channels) ? g.channels
      : (Array.isArray(g.dataList) ? g.dataList : []);
    const name = canonicalGroupName(g.name, aliases);
    if (!merged.has(name)) merged.set(name, []);
    const bucket = merged.get(name);
    for (const ch of list) bucket.push(ch && ch.group !== name ? { ...ch, group: name } : ch);
  }
  // 再做 URL 全局去重；dedupeByUrl 返回的分组已同时带 channels/dataList 双字段。
  return dedupeByUrl([...merged.entries()].map(([name, dataList]) => ({ name, dataList })));
}

// ---------- 默认配置 ----------
const DEFAULT_SYS = {
  port: 0, host: '', pass: '', adminPath: 'admin',
  programInfoUpdateInterval: '8', enableDisplayNameUnify: false,
  cctvLogoStyle: 'dark', proxy: '', proxyEnvFallback: false,
  proxyModules: [], envOverrides: {},
};
const DEFAULT_EXT = () => ({
  enabled: true, includeInPlaylists: true, updateOnStartup: true,
  sources: [], fetchStatus: {}, proxy: '',
});
const DEFAULT_PLAYLIST_CFG = () => ({
  channelGroupMap: {}, channelRenameMap: {}, channelOrder: {},
  hiddenChannels: [], customGroups: [], groupOrder: [], deletedGroups: [],
  groupRenameMap: {}, groupSortMode: {}, hiddenRules: [], keepRules: [],
  keepRuleSources: [], disabledSources: [],
});
const DEFAULT_EXTRACTORS = { enabled: true, modules: [], contentFlags: {} };

// 定时刷新：Cron 每小时检查一次，真正拉取的间隔由 KV 配置控制（默认 24 小时）
const DEFAULT_AUTO_REFRESH = () => ({
  enabled: true,
  intervalHours: 24,
  lastRunAt: 0,
  lastResult: null,
});
const AUTO_REFRESH_LOCK_KEY = 'auto-refresh-lock';
const AUTO_REFRESH_LOCK_TTL = 600; // 秒：防止上一次刷新未结束时重复执行

// ---------- M3U / TXT 解析（复刻上游 externalSources.js）----------
function extractExtinfName(line) {
  const lastQuote = line.lastIndexOf('"');
  if (lastQuote !== -1) {
    const after = line.slice(lastQuote + 1);
    const comma = after.indexOf(',');
    if (comma !== -1) return after.slice(comma + 1).trim();
  }
  const comma = line.indexOf(',');
  return comma !== -1 ? line.slice(comma + 1).trim() : '';
}

// 收集 #EXTVLCOPT 等选项，直到下一个非注释行（URL）
function collectOptsUntilUrl(lines, start) {
  const opts = [];
  for (let j = start + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!l) continue;
    if (l.startsWith('#')) {
      const m = l.match(/^#EXTVLCOPT:(.*)$/i);
      if (m) opts.push(m[1].trim());
      continue;
    }
    return { opts, urlIndex: j };
  }
  return { opts, urlIndex: -1 };
}

function parseCatchupAttrs(line) {
  const out = {};
  const m1 = line.match(/catchup="([^"]*)"/i);
  const m2 = line.match(/catchup-days="?(\d+)"?/i);
  const m3 = line.match(/catchup-source="([^"]*)"/i);
  if (m1) out.catchup = m1[1];
  if (m2) out.catchupDays = parseInt(m2[1], 10);
  if (m3) out.catchupSource = m3[1];
  return out;
}
function resolveCatchup(header, line) {
  const inline = parseCatchupAttrs(line);
  return { ...header, ...inline };
}

function parseM3uContent(content) {
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l);
  const channels = [];
  let headerCatchup = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\uFEFF?#EXTM3U/i.test(line)) { headerCatchup = parseCatchupAttrs(line); continue; }
    if (!line.startsWith('#EXTINF:')) continue;
    const groupMatch = line.match(/group-title="([^"]*)"/);
    const logoMatch = line.match(/tvg-logo="([^"]*)"/);
    const tvgNameMatch = line.match(/tvg-name="([^"]*)"/);
    const tvgIdMatch = line.match(/tvg-id="([^"]*)"/);
    const topFirst = /\sx-top-first="(?:1|true)"/i.test(line);
    const name = extractExtinfName(line);
    const catchup = resolveCatchup(headerCatchup, line);
    const { opts, urlIndex } = collectOptsUntilUrl(lines, i);
    const url = urlIndex === -1 ? '' : lines[urlIndex];
    if (url && name) {
      channels.push({
        name,
        group: groupMatch ? groupMatch[1] : '未分组',
        logo: logoMatch ? logoMatch[1] : '',
        url,
        ...(tvgNameMatch ? { tvgName: tvgNameMatch[1] } : {}),
        ...(tvgIdMatch ? { tvgId: tvgIdMatch[1] } : {}),
        ...(opts.length ? { opts } : {}),
        ...(topFirst ? { topFirst: true } : {}),
        ...catchup,
      });
    }
  }
  return channels;
}

function parseTxtContent(content) {
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l);
  const channels = [];
  let currentGroup = '';
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    const comma = line.indexOf(',');
    if (comma === -1) continue;
    const name = line.slice(0, comma).trim();
    const rest = line.slice(comma + 1).trim();
    if (!name || !rest) continue;
    if (rest.toLowerCase() === '#genre#') { currentGroup = name; continue; }
    const url = rest.split('#')[0].trim();
    if (!url || !url.includes('://')) continue;
    channels.push({ name, group: currentGroup, logo: '', url });
  }
  return channels;
}

function parsePlaylistContent(content) {
  const head = content.replace(/^\uFEFF/, '');
  if (/^#EXTM3U/i.test(head) || /#EXTINF:/i.test(head)) return parseM3uContent(content);
  return parseTxtContent(content);
}

// 解码订阅内容（UTF-8 / GBK 简单处理： Workers TextDecoder 支持 gbk）
function decodeBody(buf, contentType) {
  const encMatch = /charset=([\w-]+)/i.exec(contentType || '');
  let enc = (encMatch ? encMatch[1] : 'utf-8').toLowerCase();
  if (enc === 'gb2312') enc = 'gbk';
  try { return new TextDecoder(enc).decode(buf); }
  catch { return new TextDecoder('utf-8').decode(buf); }
}

// ---------- 抓取订阅 ----------
async function fetchSubscription(source) {
  const url = source.subscriptionUrl || source.m3u8Url || '';
  if (!url) throw new Error('未配置订阅地址');
  const ctrl = new AbortController();
  const timeoutMs = Math.min(60000, Math.max(5000, Number(source.fetchTimeout) * 1000 || 15000));
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': source.userAgent || 'Mozilla/5.0 (IPTV; Cloudflare Worker)' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    const content = decodeBody(buf, resp.headers.get('content-type'));
    const channels = parsePlaylistContent(content);
    if (!channels.length) throw new Error('未解析出任何频道');
    return { channels, content };
  } finally { clearTimeout(timer); }
}

// ---------- 生成播放列表 ----------
function stableId(name, url) {
  let h = 5381;
  const s = `${name}|${url}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// 把 ext-config + channels 重新生成为 M3U 文本
function buildM3u(extConfig, channels, sysConfig) {
  const lines = ['#EXTM3U'];
  const groups = Array.isArray(channels) ? channels : [];
  for (const g of groups) {
    for (const ch of (g.dataList || [])) {
      const attrs = [];
      if (ch.tvgId) attrs.push(`tvg-id="${ch.tvgId}"`);
      if (ch.tvgName || ch.name) attrs.push(`tvg-name="${ch.tvgName || ch.name}"`);
      if (ch.logo) attrs.push(`tvg-logo="${ch.logo}"`);
      attrs.push(`group-title="${g.name || ch.group || '未分组'}"`);
      if (ch.catchup) attrs.push(`catchup="${ch.catchup}"`);
      if (ch.catchupDays) attrs.push(`catchup-days="${ch.catchupDays}"`);
      if (ch.catchupSource) attrs.push(`catchup-source="${ch.catchupSource}"`);
      lines.push(`#EXTINF:-1 ${attrs.join(' ')},${ch.name}`);
      if (Array.isArray(ch.opts)) for (const o of ch.opts) lines.push(`#EXTVLCOPT:${o}`);
      lines.push(ch.url);
    }
  }
  return lines.join('\n') + '\n';
}

// ---------- 关键字自动分组规则（复刻上游 groupRulesAPI.js / channelMerger.js）----------
// 规则格式：[{ group, keywords: [] }]，数组顺序即优先级（首条命中胜）。
// 只对「未分组」频道生效：源已分好组的频道保持不动，手动移动优先（见 applyKeywordGroup）。
const GROUP_RULES_KEY = 'group-keyword-rules';

// 读取并规整规则：去空、去空关键字、按 group 去重（保留首次出现位置）
async function loadGroupRules(env) {
  const raw = await kvGet(env, GROUP_RULES_KEY, []);
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const group = typeof r?.group === 'string' ? r.group.trim() : '';
    const keywords = Array.isArray(r?.keywords)
      ? [...new Set(r.keywords.map(k => String(k).trim()).filter(Boolean))]
      : [];
    if (!group || !keywords.length || seen.has(group)) continue;
    seen.add(group);
    out.push({ group, keywords });
  }
  return out;
}

// 频道名按规则匹配分组：子串包含、大小写不敏感、首条命中胜；空关键字跳过。无命中返回 null。
function matchGroupByRules(name, rules) {
  if (!name || !Array.isArray(rules)) return null;
  const lower = String(name).toLowerCase();
  for (const r of rules) {
    const kws = Array.isArray(r?.keywords) ? r.keywords : [];
    if (kws.some(k => { const kk = String(k).toLowerCase(); return kk && lower.includes(kk); })) {
      return r.group;
    }
  }
  return null;
}

// 从外部源配置重建频道分组数组；rules 为关键字规则，aliases 为组名归一化别名
function rebuildChannels(extConfig, rules = [], aliases = null) {
  const groups = new Map();
  const sources = Array.isArray(extConfig.sources) ? extConfig.sources : [];
  for (const src of sources) {
    if (src.enabled === false) continue;
    // 来源标识：前端 sourceNamesFor 映射 ext:<id> → 源名（徽标显示）；去重时并入 sourceIds
    const sourceId = src.id ? `ext:${src.id}` : '';
    if (src.mode === 'subscription' && Array.isArray(src.parsedChannels)) {
      for (const ch of src.parsedChannels) {
        let gname;
        if (src.ignoreGroups) {
          // 忽略源自带分组：按名字匹配规则；未命中的进该源的「默认分组」
          const matched = matchGroupByRules(ch.name, rules);
          gname = matched || (src.group || '未分组');
        } else {
          gname = ch.group && ch.group !== '未分组' ? ch.group : (src.group || '未分组');
          // 关键字自动分组：仅当频道仍落在「未分组」时尝试归类（源已分好的组不动）
          if (gname === '未分组') {
            const matched = matchGroupByRules(ch.name, rules);
            if (matched) gname = matched;
          }
        }
        // 组名智能归一化：同义组名（央视频/央视/CCTV）合并到统一组名
        gname = canonicalGroupName(gname, aliases);
        if (!groups.has(gname)) groups.set(gname, []);
        groups.get(gname).push({
          id: ch.id || stableId(ch.name, ch.url),
          name: ch.name, url: ch.url, group: gname,
          ...(sourceId ? { sourceId } : {}),
          ...(ch.logo ? { logo: ch.logo } : {}),
          ...(ch.opts ? { opts: ch.opts } : {}),
        });
      }
    } else if ((src.mode === 'direct' || src.mode === 'fetch') && src.m3u8Url) {
      let gname = src.group || '未分组';
      if (gname === '未分组') {
        const matched = matchGroupByRules(src.name, rules);
        if (matched) gname = matched;
      }
      gname = canonicalGroupName(gname, aliases);
      if (!groups.has(gname)) groups.set(gname, []);
      groups.get(gname).push({
        id: src.id || stableId(src.name, src.m3u8Url),
        name: src.name || '未命名', url: src.m3u8Url, group: gname,
        ...(sourceId ? { sourceId } : {}),
      });
    }
  }
  return normalizeGroups([...groups.entries()].map(([name, dataList]) => ({ name, dataList })));
}

// 保存配置后同步重建频道 + M3U（自动应用最新关键字分组规则）
async function persistAndRebuild(env, extConfig) {
  await kvPut(env, 'ext-config', extConfig);
  const [rules, aliases] = await Promise.all([loadGroupRules(env), loadGroupAliases(env)]);
  const channels = rebuildChannels(extConfig, rules, aliases);
  await kvPut(env, 'channels', channels);
  const sys = await kvGet(env, 'sys-config', DEFAULT_SYS);
  // M3U 是纯文本，直接存 raw（不要走 kvPut 的 JSON.stringify，否则读出来带引号）
  await env.IPTV_KV.put('playlist-m3u', buildM3u(extConfig, channels, sys));
}

// ---------- 定时自动刷新订阅 ----------
function normalizeAutoRefresh(raw) {
  const d = DEFAULT_AUTO_REFRESH();
  if (!raw || typeof raw !== 'object') return d;
  const hours = Number(raw.intervalHours);
  return {
    enabled: raw.enabled !== false,
    intervalHours: Number.isFinite(hours) ? Math.min(720, Math.max(1, hours)) : d.intervalHours,
    lastRunAt: Number(raw.lastRunAt) || 0,
    lastResult: raw.lastResult && typeof raw.lastResult === 'object' ? raw.lastResult : null,
  };
}

// 拉起所有「订阅模式 + 有 URL + 未禁用 + 非本地粘贴」的外部源，逐条更新 parsedChannels。
// 单条失败只记录状态，保留上一次成功解析的频道，避免订阅抖动导致播放列表被清空。
async function runAutoRefresh(env, { force = false, cron = '' } = {}) {
  const now = Date.now();
  const cfg = normalizeAutoRefresh(await kvGet(env, 'auto-refresh', null));

  if (!cfg.enabled && !force) {
    return { status: 'disabled', message: '自动刷新已关闭' };
  }
  if (!force && cfg.lastRunAt && now - cfg.lastRunAt < cfg.intervalHours * 3600 * 1000) {
    return {
      status: 'skipped',
      message: `未到刷新间隔（${cfg.intervalHours} 小时）`,
      lastRunAt: cfg.lastRunAt,
      nextRunAt: cfg.lastRunAt + cfg.intervalHours * 3600 * 1000,
    };
  }

  // KV TTL 锁：防止上一次刷新还没跑完时重复执行
  let locked = false;
  try {
    const lock = await env.IPTV_KV.get(AUTO_REFRESH_LOCK_KEY, 'text');
    if (lock && now - Number(lock) < AUTO_REFRESH_LOCK_TTL * 1000) {
      return { status: 'skipped', message: '上一次自动刷新仍在执行' };
    }
    await env.IPTV_KV.put(AUTO_REFRESH_LOCK_KEY, String(now), { expirationTtl: AUTO_REFRESH_LOCK_TTL });
    locked = true;
  } catch { /* 锁失败不阻断刷新 */ }

  try {
    const ext = await kvGet(env, 'ext-config', DEFAULT_EXT());
    if (!Array.isArray(ext.sources)) ext.sources = [];
    if (!ext.fetchStatus || typeof ext.fetchStatus !== 'object') ext.fetchStatus = {};

    const targets = ext.sources
      .map((s, idx) => ({ s, idx }))
      .filter(({ s }) => s && s.enabled !== false && s.mode === 'subscription'
        && (s.subscriptionUrl || s.m3u8Url) && !s.localImport);

    let succeeded = 0;
    let failed = 0;
    let channelCount = 0;
    for (const { s, idx } of targets) {
      const sid = s.id || `idx_${idx}`;
      try {
        const { channels } = await fetchSubscription(s);
        ext.sources[idx].parsedChannels = channels;
        ext.sources[idx].lastUpdated = Date.now();
        ext.fetchStatus[sid] = { success: true, channelCount: channels.length, at: Date.now() };
        succeeded += 1;
        channelCount += channels.length;
      } catch (e) {
        failed += 1;
        ext.fetchStatus[sid] = {
          success: false,
          error: e && e.message ? e.message : String(e),
          at: Date.now(),
        };
      }
    }

    await persistAndRebuild(env, ext);

    cfg.lastRunAt = Date.now();
    cfg.lastResult = {
      at: cfg.lastRunAt,
      cron: cron || 'manual',
      total: targets.length,
      succeeded,
      failed,
      channelCount,
    };
    await kvPut(env, 'auto-refresh', cfg);

    return {
      status: 'ok',
      ...cfg.lastResult,
      nextRunAt: cfg.lastRunAt + cfg.intervalHours * 3600 * 1000,
    };
  } finally {
    if (locked) {
      try { await env.IPTV_KV.delete(AUTO_REFRESH_LOCK_KEY); } catch { /* 锁会由 TTL 兜底清理 */ }
    }
  }
}

// ---------- 鉴权（可选管理员口令）----------
function authorized(request, env) {
  const required = String(env.ADMIN_PASS || '');
  if (!required) return true;
  return request.headers.get('X-Admin-Pass') === required
    || (request.headers.get('Authorization') || '') === `Bearer ${required}`;
}

// ---------- 安全头 ----------
function addSecurityHeaders(response, pathname) {
  const h = new Headers(response.headers);
  if (!h.has('X-Content-Type-Options')) h.set('X-Content-Type-Options', 'nosniff');
  if (!h.has('Referrer-Policy')) h.set('Referrer-Policy', 'no-referrer');
  if (!h.has('X-Frame-Options')) h.set('X-Frame-Options', 'SAMEORIGIN');
  if (/^\/(admin|player)(\.html)?\/?$/.test(pathname) || pathname === '/') {
    h.set('Cache-Control', 'no-store');
  }
  const body = [204, 304].includes(response.status) ? null : response.body;
  return new Response(body, { status: response.status, statusText: response.statusText, headers: h });
}

// ---------- 静态重写 ----------
const STATIC_REWRITES = new Map([
  ['/player-assets/mpegts.js', '/vendor/mpegts.js'],
  ['/player-assets/hls.min.js', '/vendor/hls.min.js'],
  ['/player-assets/DPlayer.min.js', '/vendor/DPlayer.min.js'],
  ['/icon-512.png', '/icons/icon-512.png'],
  ['/icon-dark-512.png', '/icons/icon-dark-512.png'],
  ['/favicon.ico', '/icons/favicon.ico'],
  ['/favicon.svg', '/icons/favicon.svg'],
  ['/apple-touch-icon.png', '/icons/apple-touch-icon.png'],
]);

// ================= API 路由 =================
async function handleApi(request, env, url, rel) {
  const method = request.method;
  let body = {};
  if (method === 'POST' || method === 'PUT') {
    try { body = await request.json(); } catch { return fail('JSON 解析失败'); }
  }
  const seg = rel.replace(/^api\/?/i, '').replace(/\/$/, '');

  // 硬门槛 GET（页面初始化必须 200）
  if (seg === 'channels' && method === 'GET') {
    const aliases = await loadGroupAliases(env);
    return json(normalizeGroups(await kvGet(env, 'channels', []), aliases)); // 裸数组，双字段兼容
  }
  if (seg === 'system-config' && method === 'GET') {
    return json(await kvGet(env, 'sys-config', DEFAULT_SYS)); // 裸对象
  }
  if (seg === 'system-config' && method === 'POST') {
    if (!authorized(request, env)) return fail('未授权', 403);
    const cur = await kvGet(env, 'sys-config', DEFAULT_SYS);
    const next = { ...cur, ...body };
    delete next.proxyModules; delete next.envOverrides; // 只读字段不固化
    await kvPut(env, 'sys-config', next);
    return ok(next, { message: '已保存', entry: url.pathname.replace(/\/admin\/?$/, '') || '/admin', apiPrefix: '' });
  }
  if (seg === 'external-sources' && method === 'GET') {
    const cfg = await kvGet(env, 'ext-config', DEFAULT_EXT());
    return json(cfg); // 裸对象，顶层带 fetchStatus/proxy
  }
  if (seg === 'external-sources' && method === 'POST') {
    if (!authorized(request, env)) return fail('未授权', 403);
    return handleExternalSources(env, body);
  }

  // 定时刷新：查看配置 / 修改频率 / 立即手动刷新一次
  if (seg === 'auto-refresh' && method === 'GET') {
    return ok(normalizeAutoRefresh(await kvGet(env, 'auto-refresh', null)));
  }
  if (seg === 'auto-refresh' && method === 'POST') {
    if (!authorized(request, env)) return fail('未授权', 403);
    if (body.action === 'run' || body.force === true) {
      const result = await runAutoRefresh(env, { force: true, cron: 'manual' });
      const message = result.status === 'ok'
        ? `刷新完成：成功 ${result.succeeded} 个，失败 ${result.failed} 个，共 ${result.channelCount} 个频道`
        : result.message;
      return ok(result, { message });
    }
    const cur = normalizeAutoRefresh(await kvGet(env, 'auto-refresh', null));
    const next = normalizeAutoRefresh({ ...cur, ...body });
    await kvPut(env, 'auto-refresh', next);
    return ok(next, { message: '自动刷新配置已保存' });
  }

  if (seg === 'built-in-sources' && method === 'GET') {
    const v = await kvGet(env, 'built-in', { enabled: true, sources: [], builtInSubscriptionUrls: [] });
    return ok(v);
  }

  // 我的频道配置 / 播放列表
  if (seg === 'my-playlist-config' && method === 'GET') return ok(await kvGet(env, 'playlist-config', DEFAULT_PLAYLIST_CFG()));
  if (seg === 'my-playlist-config' && method === 'POST') {
    if (!authorized(request, env)) return fail('未授权', 403);
    await kvPut(env, 'playlist-config', body);
    return ok(body, { message: '已保存' });
  }
  if (seg === 'my-playlist' && method === 'GET') {
    const aliases = await loadGroupAliases(env);
    const channels = normalizeGroups(await kvGet(env, 'channels', []), aliases);
    return ok(channels, { originalData: channels, hiddenCustomGroups: [] });
  }
  if (seg === 'my-playlist-profiles' && method === 'GET') return ok([{ id: 'default', name: '默认' }]);
  if (seg === 'my-playlist-profiles' && method === 'POST') return ok(null, { message: '已保存' });
  if (seg === 'source-profiles' && method === 'GET') {
    return ok({ sources: [], profiles: [{ id: 'default', name: '默认' }], disabled: {} });
  }
  if (seg === 'source-profiles' && method === 'POST') {
    return ok({ profileId: body.profileId || 'default', disabledSources: [] });
  }

  // 二次配置：返回结构正确的空值，保证对应标签页可用
  if (seg === 'alerts') return ok([]);
  if (seg === 'epg-sources') {
    const d = { enabled: false, sources: [] };
    if (method === 'GET') return ok(d, { legacyUrls: [], defaultUrl: '' });
    return ok(body.data || d, { message: '已保存' });
  }
  if (seg === 'notify') {
    const d = { channels: [], types: [], templates: [] };
    return method === 'GET' ? ok(d) : ok(body.channel ? d : (body.data || d), { message: '已保存' });
  }
  if (seg === 'users') {
    const d = { users: [], passSet: !!String((await kvGet(env, 'sys-config', DEFAULT_SYS)).pass || '') };
    return method === 'GET' ? ok(d) : ok(d, { message: '已保存' });
  }
  if (seg === 'channel-aliases') return method === 'GET' ? ok({}) : ok(body.data || {}, { message: '已保存' });
  if (seg === 'group-keyword-rules') {
    if (method === 'GET') return ok(await loadGroupRules(env));
    if (!authorized(request, env)) return fail('未授权', 403);
    return handleGroupRules(env, body);
  }
  // 组名别名：智能合并之外的手动补充映射（含 rebuild 仅重建不改动）
  if (seg === 'group-alias') {
    if (method === 'GET') return ok(await loadGroupAliasList(env));
    if (!authorized(request, env)) return fail('未授权', 403);
    return handleGroupAlias(env, body);
  }
  if (seg === 'extractors') return method === 'GET' ? ok(DEFAULT_EXTRACTORS) : ok(body.data || DEFAULT_EXTRACTORS, { message: '已保存' });

  // 其余次要端点
  if (seg === 'check-update') return fail('Worker 模式跳过更新检查');
  if (seg === 'restart') return ok(null, { message: 'Worker 模式无需重启' });
  if (seg === 'core-dumps/clean') return ok(null, { count: 0, bytes: 0 });
  if (seg === 'proxy-test') return ok(null, { via: '', results: [], message: 'Worker 模式无需代理测试' });
  if (seg === 'config-backup') {
    if (method === 'GET') {
      const files = {
        'ext-config.json': await env.IPTV_KV.get('ext-config', 'text'),
        'system-config.json': await env.IPTV_KV.get('sys-config', 'text'),
      };
      return ok({ files, skipped: [] });
    }
    if (!authorized(request, env)) return fail('未授权', 403);
    const files = body.files || {};
    if (files['ext-config.json']) await env.IPTV_KV.put('ext-config', files['ext-config.json']);
    if (files['system-config.json']) await env.IPTV_KV.put('sys-config', files['system-config.json']);
    return ok(null, { message: '已恢复' });
  }
  if (seg === 'upload-logo' || seg === 'remove-logo' || seg === 'copy-channel') return fail('Worker 模式暂不支持');

  return fail(`未知 API: /api/${seg}`, 404);
}

// ---------- 关键字自动分组规则：CRUD（复刻上游 groupRulesAPI.js 语义）----------
// 保存后从 ext-config 原始数据重建频道 + M3U，规则立即生效。
async function handleGroupRules(env, body) {
  const action = body.action || 'setRule';
  const rules = await loadGroupRules(env);

  if (action === 'setRule') {
    const group = typeof body.group === 'string' ? body.group.trim() : '';
    if (!group) return fail('请填写分组名');
    if (group === '未分组') return fail('不能把频道自动归到「未分组」');
    let list = Array.isArray(body.keywords)
      ? body.keywords
      : String(body.keywords || '').split(/[,，\n、]/);
    list = [...new Set(list.map(s => String(s).trim()).filter(Boolean))];
    if (!list.length) return fail('请至少填写一个关键字');
    const entry = { group, keywords: list };
    const idx = rules.findIndex(r => r.group === group);
    if (idx >= 0) rules[idx] = entry; else rules.push(entry);
  } else if (action === 'moveRule') {
    if (body.direction !== 'up' && body.direction !== 'down') return fail('方向无效');
    const idx = rules.findIndex(r => r.group === body.group);
    if (idx < 0) return fail('规则不存在');
    const to = body.direction === 'up' ? idx - 1 : idx + 1;
    if (to >= 0 && to < rules.length) [rules[idx], rules[to]] = [rules[to], rules[idx]];
  } else if (action === 'removeRule') {
    const next = rules.filter(r => r.group !== body.group);
    if (next.length === rules.length) return fail('规则不存在');
    rules.length = 0;
    rules.push(...next);
  } else {
    return fail(`未知操作: ${action}`);
  }

  await kvPut(env, GROUP_RULES_KEY, rules);
  // 用最新规则重建频道与 M3U（不重新抓取订阅，仅重新归类）
  const ext = await kvGet(env, 'ext-config', DEFAULT_EXT());
  await persistAndRebuild(env, ext);
  return ok(rules, { message: '已保存' });
}

// ---------- 组名别名：CRUD（智能合并的手动补充）----------
async function loadGroupAliasList(env) {
  const raw = await kvGet(env, GROUP_ALIAS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(r => ({ from: String(r?.from || '').trim(), to: String(r?.to || '').trim() }))
    .filter(r => r.from && r.to);
}

// 保存后重建频道与 M3U（含 action:'rebuild' 只重建不改动，供部署后刷新持久化数据）
async function handleGroupAlias(env, body) {
  const action = body.action || 'set';
  const list = await loadGroupAliasList(env);

  if (action === 'set') {
    const from = String(body.from || '').trim();
    const to = String(body.to || '').trim();
    if (!from) return fail('请填写原组名');
    if (!to) return fail('请填写合并后的组名');
    if (from === '未分组') return fail('不能合并「未分组」');
    const lower = from.toLowerCase();
    const idx = list.findIndex(r => r.from.toLowerCase() === lower);
    if (idx >= 0) list[idx] = { from, to }; else list.push({ from, to });
  } else if (action === 'remove') {
    const lower = String(body.from || '').trim().toLowerCase();
    const next = list.filter(r => r.from.toLowerCase() !== lower);
    if (next.length === list.length) return fail('别名不存在');
    list.length = 0;
    list.push(...next);
  } else if (action === 'clear') {
    list.length = 0;
  } else if (action === 'rebuild') {
    // 不改动别名，仅触发重建（部署后同步持久化的 channels / M3U）
  } else {
    return fail(`未知操作: ${action}`);
  }

  await kvPut(env, GROUP_ALIAS_KEY, list);
  const ext = await kvGet(env, 'ext-config', DEFAULT_EXT());
  await persistAndRebuild(env, ext);
  return ok(list, { message: action === 'rebuild' ? '已重建' : '已保存' });
}

// ---------- 外部源：保存 + 导入订阅 ----------
async function handleExternalSources(env, body) {
  const action = body.action || 'save';
  const cfg = await kvGet(env, 'ext-config', DEFAULT_EXT());

  if (action === 'save') {
    const incoming = body.sources;
    // sources 可能是整份配置对象，也可能是裸数组
    const next = (incoming && !Array.isArray(incoming) && typeof incoming === 'object')
      ? { ...DEFAULT_EXT(), ...incoming }
      : { ...cfg, sources: Array.isArray(incoming) ? incoming : [] };
    // 给新源补稳定 id
    next.sources = next.sources.map((s, i) => ({
      ...s,
      id: s.id || `ext_${Date.now().toString(36)}_${i}`,
    }));
    await persistAndRebuild(env, next);
    return ok(next, { message: '已保存' });
  }

  if (action === 'importSubscription') {
    const idx = Number(body.index);
    const src = cfg.sources[idx];
    if (!src) return fail('找不到该订阅源');
    if (!src.subscriptionUrl && !src.localImport) return fail('未填写订阅地址');
    try {
      let channels;
      if (src.localImport && src.subscriptionContent) {
        channels = parsePlaylistContent(src.subscriptionContent);
      } else {
        channels = (await fetchSubscription(src)).channels;
      }
      if (!channels.length) return fail('未解析出任何频道');
      cfg.sources[idx].parsedChannels = channels;
      cfg.sources[idx].lastUpdated = Date.now();
      await persistAndRebuild(env, cfg);
      return ok(cfg, { message: `成功导入 ${channels.length} 个频道`, channelCount: channels.length });
    } catch (e) {
      return fail(`导入失败：${e && e.message ? e.message : e}`);
    }
  }

  if (action === 'parseLocalContent') {
    try {
      const raw = body.contentBase64 || '';
      const buf = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
      const text = decodeBody(buf.buffer, 'text/plain;charset=utf-8');
      const channels = parsePlaylistContent(text);
      return ok(text, { text, channelCount: channels.length, success: true });
    } catch (e) { return fail(`解析失败：${e.message}`); }
  }

  if (action === 'probeStatus') return ok({ state: 'idle' });
  if (action === 'probeCancel') return ok(null);
  if (action === 'probeStart') return fail('Worker 模式暂不支持失效检测');

  return fail(`未知操作: ${action}`);
}

// ================= 播放列表输出 =================
async function handlePlaylistOut(env, url, rel) {
  const first = rel.split('/')[0].toLowerCase();
  if (first === 'm3u' || first === 'interface.m3u' || first === 'txt') {
    const m3u = await env.IPTV_KV.get('playlist-m3u', 'text');
    const headers = { ...TEXT_HEADERS, 'Content-Disposition': 'inline; filename="interface.m3u"' };
    return new Response(m3u || '#EXTM3U\n', { headers });
  }
  if (first === 'playback.xml') {
    return new Response('<?xml version="1.0" encoding="UTF-8"?><tv></tv>', {
      headers: { 'Content-Type': 'application/xml;charset=UTF-8' },
    });
  }
  if (first === 'logos' || first === 'u' || first === 'relay') {
    return new Response('Not Found', { status: 404 });
  }
  return new Response('Not Found', { status: 404 });
}

// ================= Worker 入口 =================
export default {
  // Cloudflare Cron Trigger：每小时触发一次，实际是否拉取由 auto-refresh KV 配置决定
  async scheduled(controller, env) {
    try {
      const result = await runAutoRefresh(env, { cron: controller.cron || '' });
      console.log('[auto-refresh]', JSON.stringify(result));
      // 所有可预期结果都已妥善记录，无需 Cloudflare 重复执行
      if (controller.noRetry) controller.noRetry();
      return result;
    } catch (e) {
      console.error('[auto-refresh] failed:', e && e.message ? e.message : e);
      try { if (controller.noRetry) controller.noRetry(); } catch { /* ignore */ }
      return { status: 'error', message: e && e.message ? e.message : String(e) };
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const rel = url.pathname.replace(/^\/+/, '');
    const first = rel.split('/')[0] || '';

    if (url.pathname === '/') {
      return new Response(null, { status: 302, headers: { Location: '/admin', 'Cache-Control': 'no-store' } });
    }

    if (/^api(\/|$)/i.test(first)) {
      return handleApi(request, env, url, rel);
    }
    if (/^(m3u|interface\.m3u|playback\.xml|txt|u|relay|logos)(\/|$)/i.test(first)) {
      return handlePlaylistOut(env, url, rel);
    }

    const rewritten = STATIC_REWRITES.get(url.pathname);
    if (rewritten) {
      const assetReq = new Request(new URL(rewritten, url.origin), request);
      const res = await env.ASSETS.fetch(assetReq);
      if (res.status !== 404) return addSecurityHeaders(res, url.pathname);
    }
    const res = await env.ASSETS.fetch(request);
    return addSecurityHeaders(res, url.pathname);
  },
};
