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
 *   其余小配置各占一键（aliases/group-rules/epg/notify/users/extractors/...）
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
function normalizeGroups(groups) {
  return dedupeByUrl(groups).map(g => {
    const list = Array.isArray(g.channels) ? g.channels
      : (Array.isArray(g.dataList) ? g.dataList : []);
    return { ...g, channels: list, dataList: list };
  });
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

// 从外部源配置重建频道分组数组
function rebuildChannels(extConfig) {
  const groups = new Map();
  const sources = Array.isArray(extConfig.sources) ? extConfig.sources : [];
  for (const src of sources) {
    if (src.enabled === false) continue;
    // 来源标识：前端 sourceNamesFor 映射 ext:<id> → 源名（徽标显示）；去重时并入 sourceIds
    const sourceId = src.id ? `ext:${src.id}` : '';
    if (src.mode === 'subscription' && Array.isArray(src.parsedChannels)) {
      for (const ch of src.parsedChannels) {
        const gname = src.ignoreGroups ? '未分组' : (ch.group && ch.group !== '未分组' ? ch.group : (src.group || '未分组'));
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
      const gname = src.group || '未分组';
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

// 保存配置后同步重建频道 + M3U
async function persistAndRebuild(env, extConfig) {
  await kvPut(env, 'ext-config', extConfig);
  const channels = rebuildChannels(extConfig);
  await kvPut(env, 'channels', channels);
  const sys = await kvGet(env, 'sys-config', DEFAULT_SYS);
  // M3U 是纯文本，直接存 raw（不要走 kvPut 的 JSON.stringify，否则读出来带引号）
  await env.IPTV_KV.put('playlist-m3u', buildM3u(extConfig, channels, sys));
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
    return json(normalizeGroups(await kvGet(env, 'channels', []))); // 裸数组，双字段兼容
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
    const channels = normalizeGroups(await kvGet(env, 'channels', []));
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
  if (seg === 'group-keyword-rules') return method === 'GET' ? ok([]) : ok(body.data || [], { message: '已保存' });
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
