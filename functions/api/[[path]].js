/**
 * Cloudflare Pages Function —— iPTV 后端 API 同域反代
 *
 * 前端（admin.html / player.html）全部用相对路径请求 /api/...。
 * 在 Pages 上这些请求会打到本函数，再透传到真正的后端（Docker 宿主机，经 Cloudflare Tunnel 暴露）。
 *
 * 后端鉴权走「URL 路径里的密码段」：/<pass>/api/...
 * 因此这里读取 BACKEND_PASS 环境变量并注入路径前缀，前端无需知道密码，也不会出现在浏览器里。
 *
 * 环境变量（在 Cloudflare Pages 项目 Settings → Environment variables 配置）：
 *   BACKEND_ORIGIN 必填，例如 https://iptv.example.com （Tunnel 域名，不要带尾斜杠和路径）
 *   BACKEND_PASS   可选，后端系统配置的访问密码；为空则不加密码前缀
 *   BACKEND_PREFIX 可选，后端挂在反向代理子路径时填写，例如 /iptv（默认空）
 */

const JSON_HEADERS = { 'Content-Type': 'application/json;charset=UTF-8' };

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, 'Cache-Control': 'no-store', ...extra },
  });
}

// 不允许被透传的逐跳 / 敏感请求头（交给 Cloudflare 重新生成）
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

export async function onRequest(context) {
  const { request, env, params } = context;

  const origin = String(env.BACKEND_ORIGIN || '').replace(/\/+$/, '');
  if (!origin) {
    return json({ success: false, message: 'BACKEND_ORIGIN 未配置' }, 500);
  }

  const url = new URL(request.url);
  const pass = String(env.BACKEND_PASS || '').replace(/^\/+|\/+$/g, '');
  const prefix = String(env.BACKEND_PREFIX || '').replace(/^\/+|\/+$/g, '');

  // 拼出后端的真实路径：<prefix>/<pass>/api/[[path]]?<原始 query>
  const segments = [prefix, pass, 'api', (params.path || []).join('/')]
    .filter(Boolean).map(s => encodeURI(decodeURIComponent(s))).join('/');
  const target = `${origin}/${segments}${url.search}`;

  const init = {
    method: request.method,
    headers: cleanHeaders(request.headers),
    redirect: 'manual',
  };
  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = request.body;
    // duplex 是 streaming body 的必需项
    init.duplex = 'half';
  }

  try {
    const upstream = await fetch(target, init);
    const outHeaders = cleanHeaders(upstream.headers);
    // 后端管理 API 没有 CORS 头；同域反代本来不需要，但补齐可让直连调试也能用
    outHeaders.set('Access-Control-Allow-Origin', '*');
    outHeaders.set('Cache-Control', 'no-store');
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
