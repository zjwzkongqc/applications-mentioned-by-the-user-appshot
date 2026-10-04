const LIMIT = 2 * 1024 * 1024;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function supabaseOrigin(value) {
  if (typeof value !== 'string' || !value) throw new Error('SUPABASE_URL is required.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port) throw new Error('SUPABASE_URL must be a trusted HTTPS project origin.');
  return url.origin;
}

function objectPath(key) {
  if (typeof key !== 'string' || !key || key.length > 1024 || key.startsWith('/') || key.includes('\\') || key.includes('\0') || key.split('/').some(part => !part || part === '.' || part === '..')) throw new TypeError('Invalid avatar object key.');
  return key.split('/').map(encodeURIComponent).join('/');
}

function imageBody(stream) {
  if (!stream) return null;
  const reader = stream.getReader(); let size = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { controller.close(); reader.releaseLock(); return; }
        size += next.value.byteLength;
        if (size > LIMIT) { await reader.cancel(); throw new Error('Private image body exceeds its limit.'); }
        controller.enqueue(next.value);
      } catch {
        try { await reader.cancel(); } catch { /* Keep upstream errors private. */ }
        reader.releaseLock();
        controller.error(new Error('Private image read failed.'));
      }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } }
  });
}

export function createSupabaseBucket({ url, serviceRoleKey, fetch: request = globalThis.fetch, bucket = 'tennis-avatars' }) {
  const origin = supabaseOrigin(url);
  if (typeof serviceRoleKey !== 'string' || !serviceRoleKey || /[\r\n]/.test(serviceRoleKey)) throw new Error('A server-only Storage key is required.');
  if (!/^[a-z0-9_-]{1,63}$/.test(bucket)) throw new Error('Invalid private avatar bucket.');
  const headers = () => ({ apikey: serviceRoleKey, Authorization: 'Bearer ' + serviceRoleKey });
  const transport = async (...args) => { try { return await request(...args); } catch { throw new Error('Private avatar service is unavailable.'); } };
  const resource = '/storage/v1/object/' + bucket;
  return {
    async put(key, value, options = {}) {
      const path = objectPath(key), type = options.httpMetadata?.contentType;
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : null;
      if (!bytes || bytes.byteLength > LIMIT || !TYPES.has(type)) throw new TypeError('Avatar body or image type is invalid.');
      const response = await transport(origin + resource + '/' + path, { method: 'POST', headers: { ...headers(), 'Content-Type': type, 'x-upsert': 'true' }, body: bytes, redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Private avatar upload failed.'); }
      await response.body?.cancel();
    },
    async get(key) {
      const path = objectPath(key);
      const response = await transport(origin + '/storage/v1/object/authenticated/' + bucket + '/' + path, { headers: headers(), redirect: 'error' });
      if (response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); throw new Error('Private avatar read failed.'); }
      const type = response.headers.get('Content-Type')?.split(';')[0].trim();
      const sizeHeader = response.headers.get('Content-Length'), size = sizeHeader === null ? null : Number(sizeHeader);
      if (!TYPES.has(type) || (size !== null && (!Number.isSafeInteger(size) || size < 0 || size > LIMIT))) { await response.body?.cancel(); throw new Error('Private avatar metadata is invalid.'); }
      // R2 callers either stream the private image or read it once while
      // exporting a group backup. Both paths share the same bounded body.
      const body = imageBody(response.body);
      return { body, size, httpMetadata: { contentType: type }, arrayBuffer: () => new Response(body).arrayBuffer() };
    },
    async delete(key) {
      objectPath(key);
      const response = await transport(origin + resource, { method: 'DELETE', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [key] }), redirect: 'error' });
      if (!response.ok && response.status !== 404) { await response.body?.cancel(); throw new Error('Private avatar removal failed.'); }
      await response.body?.cancel();
    }
  };
}
