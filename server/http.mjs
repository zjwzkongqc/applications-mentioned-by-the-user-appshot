import http from 'node:http';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PAGES_ORIGIN = 'https://zjwzkongqc.github.io';
const JSON_LIMIT = 20000;
const AVATAR_LIMIT = 2 * 1024 * 1024;
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export function validatePublicOrigin(value) {
  if (typeof value !== 'string' || !value) throw new Error('PUBLIC_API_ORIGIN is required.');
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_API_ORIGIN must be an origin without a path or credentials.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('PUBLIC_API_ORIGIN requires HTTPS except for local development.');
  return url.origin;
}

function address(value) {
  const normalized = value?.startsWith('::ffff:') ? value.slice(7) : value;
  return isIP(normalized || '') ? normalized : null;
}

function clientAddress(request, trustedProxyHops) {
  const direct = address(request.socket.remoteAddress) || 'unknown';
  if (!trustedProxyHops) return direct;
  const chain = String(request.headers['x-forwarded-for'] || '').split(',').map(value => address(value.trim()));
  if (chain.length < trustedProxyHops || chain.some(value => !value)) return direct;
  return chain[chain.length - trustedProxyHops];
}

function requestHeaders(request, ip) {
  const headers = new Headers();
  const excluded = new Set([...HOP_HEADERS, 'host', 'cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded']);
  for (const value of String(request.headers.connection || '').split(',')) excluded.add(value.trim().toLowerCase());
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || excluded.has(name.toLowerCase())) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  // The shared worker expects an edge-verified address under this name. Never
  // accept it from a public request on a non-Cloudflare host.
  headers.set('CF-Connecting-IP', ip);
  return headers;
}

function readBody(request, limit) {
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) {
    request.resume();
    return Promise.reject(Object.assign(new Error('Request body exceeds its limit.'), { status: 413 }));
  }
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0, settled = false;
    const cleanup = () => {
      request.off('data', onData); request.off('end', onEnd); request.off('error', onError); request.off('aborted', onAborted);
    };
    const fail = error => { if (settled) return; settled = true; cleanup(); request.on('error', () => {}); request.resume(); reject(error); };
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > limit) fail(Object.assign(new Error('Request body exceeds its limit.'), { status: 413 }));
      else chunks.push(chunk);
    };
    const onEnd = () => { if (settled) return; settled = true; cleanup(); resolve(Buffer.concat(chunks, bytes)); };
    const onError = error => fail(error);
    const onAborted = () => fail(Object.assign(new Error('Request was aborted.'), { status: 400 }));
    request.on('data', onData); request.once('end', onEnd); request.once('error', onError); request.once('aborted', onAborted);
  });
}

function wrapperError(request, status) {
  const message = status === 413 ? '提交内容过大，请缩短文字或选择小于 2MB 的头像。' : status === 415 ? '请直接提交原始内容。' : status === 403 ? '请在原页面完成操作。' : status === 400 ? '请求格式不正确，请重试。' : '小本本暂时连不上，请稍后重试。';
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin' });
  if (request.headers.origin === PAGES_ORIGIN) headers.set('Access-Control-Allow-Origin', PAGES_ORIGIN);
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

async function writeResponse(request, outgoing, response) {
  outgoing.statusCode = response.status;
  for (const [name, value] of response.headers) if (name !== 'set-cookie' && !HOP_HEADERS.has(name)) outgoing.setHeader(name, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader('Set-Cookie', cookies);
  outgoing.setHeader('X-Content-Type-Options', 'nosniff');
  outgoing.setHeader('Referrer-Policy', 'no-referrer');
  if (request.method === 'HEAD' || !response.body) {
    if (response.body) await response.body.cancel();
    outgoing.end(); return;
  }
  await pipeline(Readable.fromWeb(response.body), outgoing);
}

export function createAppServer({ worker, env, publicOrigin, trustedProxyHops = 0, migration, maintenanceMode = false, onError = () => {} }) {
  const origin = validatePublicOrigin(publicOrigin);
  if (!maintenanceMode && (!worker?.fetch || !env?.DB || !env?.BUCKET)) throw new TypeError('The compiled worker, database, and avatar bucket are required.');
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 8) throw new TypeError('TRUST_PROXY_HOPS must be an integer between 0 and 8.');
  const server = http.createServer({ maxHeaderSize: 16384 }, async (request, outgoing) => {
    try {
      const target = request.url;
      if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || /[\\\r\n#]/.test(target)) throw Object.assign(new Error('Invalid request target.'), { status: 400 });
      const url = new URL(origin + target);
      if (url.origin !== origin) throw Object.assign(new Error('Invalid request target origin.'), { status: 400 });
      if (url.pathname === '/healthz' && ['GET', 'HEAD'].includes(request.method)) {
        if (!maintenanceMode) await env.DB.prepare('SELECT 1 AS ok').first();
        await writeResponse(request, outgoing, new Response(JSON.stringify({ ok: true, maintenance: !!maintenanceMode }), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }));
        return;
      }
      if (maintenanceMode) {
        request.resume();
        await writeResponse(request, outgoing, new Response(JSON.stringify({ ready: false, maintenance: true, error: '小本本正在迁移，请稍后再来。' }), { status: 503, headers: Object.fromEntries(wrapperError(request, 503).headers) }));
        return;
      }
      if (request.headers['content-encoding'] && request.headers['content-encoding'].toLowerCase() !== 'identity') throw Object.assign(new Error('Encoded requests are unsupported.'), { status: 415 });
      const method = request.method || 'GET';
      // Apply the shared API's mutation policy to the original headers before
      // removing hop headers: Connection must not erase an Origin check.
      if (url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const suppliedOrigin = request.headers.origin;
        if ((suppliedOrigin && suppliedOrigin !== origin && suppliedOrigin !== PAGES_ORIGIN) || (request.headers['sec-fetch-site'] === 'cross-site' && suppliedOrigin !== PAGES_ORIGIN)) throw Object.assign(new Error('Unsupported request origin.'), { status: 403 });
      }
      if (migration?.enabled && !migration.ready && url.pathname.startsWith('/api/') && !['/api/migration', '/api/migration/validate'].includes(url.pathname)) {
        await writeResponse(request, outgoing, new Response(JSON.stringify({ ready: false, error: '迁移数据尚未就绪，请稍后再试。' }), { status: 503, headers: { ...Object.fromEntries(wrapperError(request, 503).headers), 'Cache-Control': 'no-store' } }));
        return;
      }
      const headers = requestHeaders(request, clientAddress(request, trustedProxyHops));
      const hasBody = !['GET', 'HEAD'].includes(method);
      const imageUpload = method === 'POST' && (url.pathname === '/api/avatar' || /^\/api\/records\/[^/]+\/photos$/.test(url.pathname));
      const body = hasBody ? await readBody(request, imageUpload ? AVATAR_LIMIT : JSON_LIMIT) : undefined;
      if (hasBody) headers.set('Content-Length', String(body.length));
      const incoming = new Request(url, { method, headers, body });
      const migrationPath = ['/api/migration', '/api/migration/validate'].includes(url.pathname);
      // Browsers preflight JSON proof validation. This never reaches storage.
      let response;
      if (migrationPath && method === 'OPTIONS') {
        response = request.headers.origin === PAGES_ORIGIN ? new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': PAGES_ORIGIN, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin' } }) : new Response(null, { status: 403 });
      } else response = await migration?.handle(incoming) || await worker.fetch(incoming, env);
      await writeResponse(request, outgoing, response);
    } catch (error) {
      if (!error.status && !request.aborted && !outgoing.destroyed) onError(error);
      if (outgoing.headersSent || outgoing.destroyed) { outgoing.destroy(); return; }
      outgoing.setHeader('Connection', 'close');
      await writeResponse(request, outgoing, wrapperError(request, error.status || 503)).catch(() => outgoing.destroy());
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  return server;
}
