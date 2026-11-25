#!/usr/bin/env node
/**
 * 从上游 akiralereal/iptv 同步 web/ 前端静态资源。
 * 只覆盖下游文件（admin.html / player.html / icons / vendor），
 * 保留本项目自己维护的 _redirects 与 _headers。
 *
 * 用法: node scripts/sync-web.mjs [ref]
 *   ref 默认为 main，也可传 tag（如 v4.83.0）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REF = process.argv[2] || 'main';
const API = 'https://api.github.com/repos/akiralereal/iptv/git/trees/' + encodeURIComponent(REF) + '?recursive=1';
const RAW = 'https://raw.githubusercontent.com/akiralereal/iptv/' + encodeURIComponent(REF) + '/';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(root, 'web');

// 只同步这些路径，且避开 Pages 配置文件
const KEEP = new Set(['_redirects', '_headers']);

async function main() {
  console.log(`[sync] 获取上游 ${REF} 文件树...`);
  const res = await fetch(API, { headers: { 'User-Agent': 'iptv-pages-sync' } });
  if (!res.ok) throw new Error(`API 请求失败: ${res.status}`);
  const data = await res.json();

  const files = (data.tree || []).filter(
    x => x.type === 'blob' && x.path.startsWith('web/') && !KEEP.has(path.basename(x.path))
  );
  console.log(`[sync] 待同步 ${files.length} 个文件`);

  let ok = 0;
  for (const f of files) {
    const dest = path.join(webDir, f.path.slice('web/'.length));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // 单文件重试 3 次，应对网络抖动
    let buf = null;
    for (let i = 0; i < 3 && !buf; i++) {
      try {
        const r = await fetch(RAW + f.path);
        if (r.ok) buf = Buffer.from(await r.arrayBuffer());
      } catch (_) { /* retry */ }
    }
    if (!buf) { console.error(`[sync] 跳过失败: ${f.path}`); continue; }
    fs.writeFileSync(dest, buf);
    ok++;
    console.log(`[sync] ${f.path} (${buf.length} B)`);
  }
  console.log(`[sync] 完成: ${ok}/${files.length}`);
}

main().catch(e => { console.error('[sync] 失败:', e.message); process.exit(1); });
