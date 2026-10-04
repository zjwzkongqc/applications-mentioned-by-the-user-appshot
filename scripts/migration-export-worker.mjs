// Temporary maintenance/export wrapper. Normal app builds never import this file.
export const MIGRATION_EXPORT_TABLES = Object.freeze([
  'accounts', 'account_credentials', 'clubs', 'members', 'account_sessions',
  'club_invites', 'auth_failures', 'auth_registrations', 'records',
  'monthly_ratings', 'record_photos', 'audit_events', 'culture', 'cheers', 'checkins'
]);
const EXPORT_ROUTE = '/api/_owner/migration-export';
const EXPORT_PAGES_ORIGIN = 'https://zjwzkongqc.github.io';
const EXPORT_MAX_BYTES = 32 * 1024 * 1024;
const EXPORT_MAX_MEDIA_BYTES = 2 * 1024 * 1024;
const EXPORT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const EXPORT_TOKEN = /^[a-f0-9]{64}$/;
const exportEncoder = new TextEncoder();

function exportJson(value, status, extra = {}) {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra
  } });
}
function exportAuthorized(request, env, url) {
  const expected = env?.TENNIS_MIGRATION_ADMIN_TOKEN;
  const provided = request.headers.get('X-Tennis-Migration-Admin');
  if (typeof expected !== 'string' || !EXPORT_TOKEN.test(expected) ||
      typeof provided !== 'string' || !EXPORT_TOKEN.test(provided) ||
      request.method !== 'POST' || url.username || url.password || url.search || url.hash ||
      ['Origin', 'Cookie', 'Authorization', 'X-Tennis-Session'].some(header => request.headers.has(header))) return false;
  // Both inputs have a fixed length and representation before this comparison.
  let difference = 0;
  for (let index = 0; index < 64; index++) difference |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  return difference === 0;
}
function exportObjectKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 1024 &&
    !key.startsWith('/') && !key.includes('\\') && !key.includes('\0') &&
    !key.split('/').some(segment => !segment || segment === '.' || segment === '..');
}
function exportImageType(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return 'image/png';
  if (String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}
function exportBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
async function exportMedia(bucket, key) {
  const object = await bucket.get(key);
  if (!object || !Number.isSafeInteger(object.size) || object.size < 12 || object.size > EXPORT_MAX_MEDIA_BYTES) throw new Error('Incomplete media');
  const bytes = new Uint8Array(await object.arrayBuffer());
  const contentType = object.httpMetadata?.contentType;
  if (bytes.length !== object.size || bytes.length > EXPORT_MAX_MEDIA_BYTES || exportImageType(bytes) !== contentType) throw new Error('Incomplete media');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return { byteSize: bytes.length, entry: { key, contentType, dataBase64: exportBase64(bytes), sha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') } };
}
async function exportSnapshot(request, env, url) {
  if (!env.DB || typeof env.DB.prepare !== 'function' || typeof env.DB.batch !== 'function') throw new Error('Unavailable snapshot');
  // D1 executes the complete batch in one transaction. No table is paginated,
  // truncated, or read separately from the other fourteen application tables.
  const results = await env.DB.batch(MIGRATION_EXPORT_TABLES.map(table => env.DB.prepare(`SELECT * FROM ${table}`)));
  if (!Array.isArray(results) || results.length !== MIGRATION_EXPORT_TABLES.length ||
      results.some(result => result?.success === false || !Array.isArray(result?.results))) throw new Error('Incomplete snapshot');
  const tables = Object.fromEntries(MIGRATION_EXPORT_TABLES.map((table, index) => [table, results[index].results]));
  const snapshot = { formatVersion: 1, appId: 'tennis-dazi-club-2026', schemaVersion: 5,
    createdAt: new Date().toISOString(), fromApiOrigin: url.origin, tables, avatars: [] };
  let bytesUsed = exportEncoder.encode(JSON.stringify(snapshot)).byteLength;
  if (bytesUsed > EXPORT_MAX_BYTES) throw new Error('Snapshot too large');
  const keys = new Set(), photosByKey = new Map();
  for (const member of tables.members) {
    if (member.avatar_key === null) continue;
    if (!exportObjectKey(member.avatar_key)) throw new Error('Incomplete media');
    keys.add(member.avatar_key);
  }
  // Include original photos and media belonging to removed members. Keys are
  // deduplicated across avatars and photos without transforming stored bytes.
  for (const photo of tables.record_photos) {
    if (!exportObjectKey(photo.object_key) || !EXPORT_IMAGE_TYPES.has(photo.content_type) ||
        !Number.isSafeInteger(photo.byte_size) || photo.byte_size < 12 || photo.byte_size > EXPORT_MAX_MEDIA_BYTES) throw new Error('Incomplete media');
    keys.add(photo.object_key);
    if (!photosByKey.has(photo.object_key)) photosByKey.set(photo.object_key, []);
    photosByKey.get(photo.object_key).push(photo);
  }
  if (keys.size && typeof env.BUCKET?.get !== 'function') throw new Error('Unavailable media');
  for (const key of keys) {
    const { entry, byteSize } = await exportMedia(env.BUCKET, key);
    if ((photosByKey.get(key) || []).some(photo => photo.content_type !== entry.contentType || photo.byte_size !== byteSize)) throw new Error('Incomplete media');
    bytesUsed += exportEncoder.encode(JSON.stringify(entry)).byteLength + (snapshot.avatars.length ? 1 : 0);
    if (bytesUsed > EXPORT_MAX_BYTES) throw new Error('Snapshot too large');
    // Keep the existing envelope field name. It now carries all media.
    snapshot.avatars.push(entry);
  }
  const body = JSON.stringify(snapshot);
  if (exportEncoder.encode(body).byteLength > EXPORT_MAX_BYTES) throw new Error('Snapshot too large');
  return new Response(body, { headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': 'attachment; filename="tennis-migration-snapshot.json"',
    'Cache-Control': 'no-store', 'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
  } });
}

export function wrapMigrationExport(originalWorker) {
  if (!originalWorker || typeof originalWorker.fetch !== 'function') throw new TypeError('An original Worker fetch handler is required.');
  return {
    async fetch(request, env, context) {
      const url = new URL(request.url);
      if (url.pathname === EXPORT_ROUTE) {
        if (!exportAuthorized(request, env, url)) return exportJson({ error: '页面不存在。' }, 404);
        if (env.TENNIS_MIGRATION_FREEZE !== '1') return exportJson({ error: '请先暂停旧服务的写入，再导出完整备份。' }, 409);
        try { return await exportSnapshot(request, env, url); }
        catch { return exportJson({ error: '完整备份暂时无法导出，请检查存储与备份大小后重试。' }, 503); }
      }
      // Schema5's group export uses GET but appends an export audit event.
      // It is a mutation for the freeze window; ordinary reads still pass.
      if (env?.TENNIS_MIGRATION_FREEZE === '1' && url.pathname.startsWith('/api/') &&
          (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) ||
           (url.pathname === '/api/export' && ['GET', 'HEAD'].includes(request.method)))) {
        const headers = { Vary: 'Origin' };
        if (request.headers.get('Origin') === EXPORT_PAGES_ORIGIN) headers['Access-Control-Allow-Origin'] = EXPORT_PAGES_ORIGIN;
        return exportJson({ error: '小本本正在迁移，记录都还在，请稍后再保存。' }, 503, headers);
      }
      return originalWorker.fetch(request, env, context);
    }
  };
}
