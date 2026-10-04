import { supabaseOrigin } from './storage.mjs';
import { createEdgeMigration } from './migration.mjs';

const PREFIX = '/functions/v1/tennis-api';
const PAGES_ORIGIN = 'https://zjwzkongqc.github.io';
const PAGE_BASE = 'https://zjwzkongqc.github.io/applications-mentioned-by-the-user-appshot/';
const JSON_LIMIT = 20000;
const IMAGE_LIMIT = 2 * 1024 * 1024;
const HOP_HEADERS = ['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'forwarded', 'cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'];

function json(request, data, status = 200) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  if (request.headers.get('Origin') === PAGES_ORIGIN) headers.set('Access-Control-Allow-Origin', PAGES_ORIGIN);
  return new Response(JSON.stringify(data), { status, headers });
}

async function boundedBody(request, limit) {
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) { await request.body?.cancel(); throw Object.assign(new Error('Body exceeds its limit.'), { status: 413 }); }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw Object.assign(new Error('Body exceeds its limit.'), { status: 413 }); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function finalized(response) {
  const headers = new Headers(response.headers);
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  if (cookies.length) {
    headers.delete('Set-Cookie');
    for (const cookie of cookies) headers.append('Set-Cookie', cookie.replace('; Path=/api/auth/register;', '; Path=' + PREFIX + '/api/auth/register;'));
  }
  headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Referrer-Policy', 'no-referrer');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function createEdgeHandler({ worker, DB, BUCKET, publicOrigin, maintenanceMode = false, migrationId, migrationFromOrigin, migrationPageBaseUrl }) {
  const origin = supabaseOrigin(publicOrigin);
  if (!maintenanceMode && (!worker?.fetch || !DB?.prepare || !BUCKET)) throw new Error('Server-side application dependencies are unavailable.');
  const migration = maintenanceMode ? null : createEdgeMigration({ DB, publicOrigin: origin, migrationId, migrationFromOrigin, migrationPageBaseUrl });
  return async request => {
    try {
      const source = new URL(request.url);
      if (source.pathname !== PREFIX && !source.pathname.startsWith(PREFIX + '/')) return json(request, { error: '页面不存在。' }, 404);
      const pathname = source.pathname.slice(PREFIX.length) || '/';
      const canonical = new URL(origin + pathname + source.search);
      if (pathname === '/' && request.method === 'GET') return finalized(new Response(null, { status: 302, headers: { Location: PAGE_BASE, 'Cache-Control': 'no-store' } }));
      if (pathname !== '/healthz' && !pathname.startsWith('/api/')) return json(request, { error: '页面不存在。' }, 404);
      if (maintenanceMode) return pathname === '/healthz' && ['GET', 'HEAD'].includes(request.method) ? json(request, { ok: true, maintenance: true }) : json(request, { ready: false, maintenance: true, error: '小本本正在迁移，请稍后再来。' }, 503);
      const suppliedOrigin = request.headers.get('Origin');
      if (pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && ((suppliedOrigin && suppliedOrigin !== origin && suppliedOrigin !== PAGES_ORIGIN) || (request.headers.get('Sec-Fetch-Site') === 'cross-site' && suppliedOrigin !== PAGES_ORIGIN))) return json(request, { error: '请在原页面完成操作。' }, 403);
      const state = await migration.inspect();
      if (pathname === '/healthz' && ['GET', 'HEAD'].includes(request.method)) {
        return json(request, { ok: true, maintenance: !state.ready });
      }
      const migrationPath = ['/api/migration', '/api/migration/validate'].includes(pathname);
      // This deployment is a receiver for an existing application. A missing
      // deployment secret must never turn an empty project into a fresh app.
      if (!state.ready) return json(request, { ready: false, error: '迁移数据尚未就绪，请稍后再试。' }, 503);
      if (migrationPath && request.method === 'OPTIONS') return suppliedOrigin === PAGES_ORIGIN ? finalized(new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': PAGES_ORIGIN, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin' } })) : json(request, { error: '请在原页面完成操作。' }, 403);
      if (pathname === '/api/migration' && request.method === 'GET') return json(request, state.manifest);
      const encoding = request.headers.get('Content-Encoding');
      if (encoding && encoding.toLowerCase() !== 'identity') return json(request, { error: '请直接提交原始内容。' }, 415);
      const hasBody = !['GET', 'HEAD'].includes(request.method);
      const imageUpload = request.method === 'POST' && (pathname === '/api/avatar' || /^\/api\/records\/[a-f0-9-]{36}\/photos$/.test(pathname));
      const body = hasBody ? await boundedBody(request, imageUpload ? IMAGE_LIMIT : JSON_LIMIT) : undefined;
      if (migrationPath) {
        if (pathname !== '/api/migration/validate' || request.method !== 'POST') return json(request, { error: '请求方式不正确。' }, 405);
        if (!request.headers.get('Content-Type')?.includes('application/json')) return json(request, { error: '请提交有效内容。' }, 415);
        let input; try { input = JSON.parse(new TextDecoder().decode(body)); } catch { return json(request, { error: '请求格式不正确。' }, 400); }
        return json(request, await migration.validate(input));
      }
      const headers = new Headers(request.headers);
      for (const name of HOP_HEADERS) headers.delete(name);
      // Supabase's runtime is behind a gateway. A client-supplied CF/XFF value
      // cannot prove a source address, so use one conservative shared budget.
      headers.set('CF-Connecting-IP', 'tennis-supabase-edge-shared');
      if (hasBody) headers.set('Content-Length', String(body.byteLength));
      return finalized(await worker.fetch(new Request(canonical, { method: request.method, headers, body }), { DB, BUCKET }));
    } catch (error) {
      const status = [400, 413, 415].includes(error?.status) ? error.status : 503;
      return json(request, { error: status === 413 ? '提交内容过大，请缩短文字或选择小于 2MB 的图片。' : status === 400 ? '请求格式不正确，请重试。' : '小本本暂时连不上，请稍后重试。' }, status);
    }
  };
}
