/**
 * Cloudflare Pages Function —— iPTV 订阅 / 播放 / 台标路径反代（catch-all）
 *
 * 前端生成的链接里除了 /api/...，还有这些动态路径必须回到后端：
 *   /m3u, /interface.m3u, /playback.xml, /txt      → 播放列表与 EPG
 *   /u/<token>/...                                 → 用户令牌订阅入口（含其下的 m3u/EPG）
 *   /relay/<pid>/...                               → 清单直出兼容模式
 *   /logos/<file>.png                              → 用户上传到数据目录的自定义台标
 *   /player-assets/*.js 与品牌图标                 → 由 _redirects 走 Pages 本地静态文件，不进这里
 *
 * 鉴权与 api 函数一致：用 BACKEND_PASS 在路径最前面注入密码段。
 * 用户令牌路径 /u/<token>/... 保持原样透传（后端自己校验 token）。
 */

const JSON_HEADERS = { 'Content-Type': 'application/json;charset=UTF-8' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, 'Cache-Control': 'no-store' },
  });
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'host', 'content-length', 'cf-ray', 'cf-visitor', 'cf-connecting-ip',
  'cf-ipcountry', 'cf-request-id', 'x-forwarded-for', 'x-forwarded-proto',
]);

function cleanHeaders(headers) {
  const out = new Headers();
  for (const [key, value] of headers) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.set(key, value);
  }
  return out;
}

// 只透传这些已知的动态路径；其余（如 /admin.html、/favicon.ico）交回静态文件处理
const DYNAMIC = /^(m3u|interface\.m3u|playback\.xml|txt|u|relay|logos)(\/|$)/i;

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const fullPath = (params.path || []).join('/');
  const first = fullPath.split('/')[0] || '';

  // 非动态路径：尝试当作静态资源处理（Pages 通常已先命中静态文件，这里是兜底）
  if (!DYNAMIC.test(fullPath)) {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  const origin = String(env.BACKEND_ORIGIN || '').replace(/\/+$/, '');
  if (!origin) return json({ success: false, message: 'BACKEND_ORIGIN 未配置' }, 500);

  const prefix = String(env.BACKEND_PREFIX || '').replace(/^\/+|\/+$/g, '');

  // 只有「站长订阅出口」才需要注入密码段：
  //   /m3u、/interface.m3u、/playback.xml、/txt 走 passAuthed。
  // 而 /u/<token>/... 由后端靠路径首段识别用户令牌、/relay/... 靠 relay 段、
  // /logos/... 是公开台标——这三类一旦前面插了密码就会破坏后端的路径解析。
  const NEEDS_PASS = /^(m3u|interface\.m3u|playback\.xml|txt)(\/|$)/i.test(fullPath);
  const pass = NEEDS_PASS ? String(env.BACKEND_PASS || '').replace(/^\/+|\/+$/g, '') : '';

  const segments = [prefix, pass, fullPath].filter(Boolean)
    .map(s => encodeURI(decodeURIComponent(s))).join('/');
  const target = `${origin}/${segments}${url.search}`;

  const init = {
    method: request.method,
    headers: cleanHeaders(request.headers),
    redirect: 'manual',
  };
  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = request.body;
    init.duplex = 'half';
  }

  try {
    const upstream = await fetch(target, init);
    const outHeaders = cleanHeaders(upstream.headers);
    outHeaders.set('Access-Control-Allow-Origin', '*');
    // m3u / EPG 需要实时，禁止边缘缓存；台标可缓存 1 天
    outHeaders.set('Cache-Control', first.toLowerCase() === 'logos'
      ? 'public, max-age=86400' : 'no-store');
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  } catch (err) {
    return json({
      success: false,
      message: '后端不可达，请检查 BACKEND_ORIGIN 与 Tunnel 状态',
      error: String(err && err.message ? err.message : err),
    }, 502);
  }
}
