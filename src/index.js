/**
 * iPTV Pages —— 统一 Worker 入口（Cloudflare Workers + Static Assets 模式）
 *
 * 新向导用 `npx wrangler deploy` 部署，静态资源由 assets.directory=./web 提供，
 * 动态请求由本 Worker 处理。它合并了旧版 Pages Functions 的两个职责：
 *   1) /api/* 同域反代到后端（注入密码路径段鉴权）
 *   2) /m3u、/u/*、/playback.xml、/relay/*、/logos/* 反代
 *   3) 原 _redirects 的重写规则（Workers 静态资源模式不读 _redirects）
 *
 * 环境变量（Cloudflare 控制台 Settings → Environment variables）：
 *   BACKEND_ORIGIN 必填   例如 https://iptv.example.com （Tunnel 域名，不带尾斜杠）
 *   BACKEND_PASS   可选   后端系统配置的访问密码
 *   BACKEND_PREFIX 可选   反代子路径，例如 /iptv
 */

const JSON_HEADERS = { 'Content-Type': 'application/json;charset=UTF-8' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, 'Cache-Control': 'no-store' },
  });
}

// 逐跳头与 Cloudflare 内部头：不透传，由平台重新生成
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

function addSecurityHeaders(response, pathname) {
  const h = response.headers;
  if (!h.has('X-Content-Type-Options')) h.set('X-Content-Type-Options', 'nosniff');
  if (!h.has('Referrer-Policy')) h.set('Referrer-Policy', 'no-referrer');
  if (!h.has('X-Frame-Options')) h.set('X-Frame-Options', 'SAMEORIGIN');
  if (pathname === '/admin.html' || pathname === '/player.html' || pathname === '/') {
    h.set('Cache-Control', 'no-store');
  }
  return response;
}

// 原 _redirects：静态重写（内部改写路径，URL 不变）
const STATIC_REWRITES = new Map([
  ['/player-assets/mpegts.js', '/vendor/mpegts.js'],
  ['/player-assets/hls.min.js', '/vendor/hls.min.js'],
  ['/player-assets/DPlayer.min.js', '/vendor/DPlayer.min.js'],
  ['/icon-512.png', '/icons/icon-512.png'],
  ['/icon-dark-512.png', '/icons/icon-dark-512.png'],
  ['/favicon.ico', '/icons/favicon.ico'],
  ['/favicon.svg', '/icons/favicon.svg'],
  ['/apple-touch-icon.png', '/icons/apple-touch-icon.png'],
  ['/admin', '/admin.html'],
  ['/player', '/player.html'],
]);

// 需要反代到后端的动态路径
const DYNAMIC = /^(api|m3u|interface\.m3u|playback\.xml|txt|u|relay|logos)(\/|$)/i;
// 只有这些「站长订阅出口」需要注入密码；/u/<token>、/relay、/logos 靠各自路径首段解析
const NEEDS_PASS = /^(m3u|interface\.m3u|playback\.xml|txt)(\/|$)/i;

async function proxyToBackend(request, env, url, pathname, search) {
  const origin = String(env.BACKEND_ORIGIN || '').replace(/\/+$/, '');
  if (!origin) return json({ success: false, message: 'BACKEND_ORIGIN 未配置' }, 500);

  const prefix = String(env.BACKEND_PREFIX || '').replace(/^\/+|\/+$/g, '');
  const pass = NEEDS_PASS.test(pathname)
    ? String(env.BACKEND_PASS || '').replace(/^\/+|\/+$/g, '') : '';

  const segments = [prefix, pass, pathname].filter(Boolean)
    .map(s => encodeURI(decodeURIComponent(s))).join('/');
  const target = `${origin}/${segments}${search}`;

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
    outHeaders.set('Cache-Control',
      pathname.toLowerCase().startsWith('logos/') ? 'public, max-age=86400' : 'no-store');
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // pathname 去掉开头斜杠，例如 /api/channels -> api/channels
    const rel = url.pathname.replace(/^\/+/, '');
    const first = rel.split('/')[0] || '';

    // 根路径：跳转到管理页
    if (url.pathname === '/') {
      return new Response(null, {
        status: 302,
        headers: { Location: '/admin.html', 'Cache-Control': 'no-store' },
      });
    }

    // 动态路径 → 反代后端
    if (DYNAMIC.test(rel)) {
      return proxyToBackend(request, env, url, rel, url.search);
    }

    // 静态重写：把请求路径换成目标资源路径，交给 ASSETS
    const rewritten = STATIC_REWRITES.get(url.pathname);
    if (rewritten) {
      const assetReq = new Request(new URL(rewritten, url.origin), request);
      const res = await env.ASSETS.fetch(assetReq);
      if (res.status !== 404) return addSecurityHeaders(res, url.pathname);
      // 目标不存在则继续走原路径，让 ASSETS 兜底
    }

    // 其余：静态资源
    const res = await env.ASSETS.fetch(request);
    return addSecurityHeaders(res, url.pathname);
  },
};
