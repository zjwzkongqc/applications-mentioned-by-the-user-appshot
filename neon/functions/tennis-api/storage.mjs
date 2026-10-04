import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { ImportError, validateObjectKey } from '../../../supabase/functions/tennis-api/import.mjs';

const LIMIT = 2 * 1024 * 1024;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const REGIONS = '(?:us-east-1|us-east-2|eu-central-1|ap-southeast-1)';
const FUNCTION_HOST = new RegExp('^[a-z0-9-]+\\.compute\\.[a-z0-9-]+\\.' + REGIONS + '\\.aws\\.neon\\.tech$');
const STORAGE_HOST = new RegExp('^[a-z0-9-]+\\.storage\\.[a-z0-9-]+\\.' + REGIONS + '\\.aws\\.neon\\.tech$');

function httpsOrigin(value, hostPattern, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(label + ' is invalid.'); }
  if (typeof value !== 'string' || url.origin !== value || url.protocol !== 'https:' || url.username || url.password || url.port || !hostPattern.test(url.hostname)) throw new Error(label + ' is invalid.');
  return url.origin;
}
export const neonOrigin = value => httpsOrigin(value, FUNCTION_HOST, 'The trusted Neon Functions origin');
export const neonStorageOrigin = value => httpsOrigin(value, STORAGE_HOST, 'The private Neon Storage origin');

export function neonS3Options(environment) {
  // These values are injected by the selected Neon branch. The SDK receives
  // explicit credentials, so it cannot fall back to another account or host.
  const endpoint = neonStorageOrigin(environment.AWS_ENDPOINT_URL_S3?.replace(/\/$/, ''));
  const region = environment.AWS_REGION;
  if (!new RegExp('^' + REGIONS + '$').test(region || '') || !new URL(endpoint).hostname.endsWith('.' + region + '.aws.neon.tech')) throw new Error('The private Storage region is invalid.');
  const credential = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\r\n\0]/.test(value);
  if (!credential(environment.AWS_ACCESS_KEY_ID) || !credential(environment.AWS_SECRET_ACCESS_KEY)) throw new Error('The injected private Storage credentials are unavailable.');
  return { endpoint, region, credentials: { accessKeyId: environment.AWS_ACCESS_KEY_ID, secretAccessKey: environment.AWS_SECRET_ACCESS_KEY },
    forcePathStyle: true, followRegionRedirects: false, maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' };
}

function bytesOf(value) {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
}
async function imageBytes(value, type) {
  const bytes = value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : bytesOf(value);
  if (!bytes || bytes.byteLength > LIMIT || !TYPES.has(type)) throw new TypeError('Private image body or content type is invalid.');
  return bytes;
}
function discardBody(body) {
  try { if (typeof body?.destroy === 'function') body.destroy(); else if (typeof body?.cancel === 'function') return body.cancel().catch(() => {}); } catch { /* No upstream values in errors. */ }
}
function webBody(body) {
  if (!body) throw new Error('Private image read failed.');
  if (typeof body.getReader === 'function') return body;
  if (typeof body.transformToWebStream === 'function') return body.transformToWebStream();
  if (body instanceof Readable) return Readable.toWeb(body);
  throw new Error('Private image read failed.');
}
function boundedImage(body) {
  let stream;
  try { stream = webBody(body); } catch { discardBody(body); throw new Error('Private image read failed.'); }
  const reader = stream.getReader(); let size = 0, released = false;
  const release = () => { if (!released) { reader.releaseLock(); released = true; } };
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { controller.close(); release(); return; }
        const bytes = bytesOf(next.value);
        if (!bytes || (size += bytes.byteLength) > LIMIT) throw new Error();
        controller.enqueue(bytes);
      } catch {
        try { await reader.cancel(); } catch { /* Keep transport failures private. */ }
        release(); controller.error(new Error('Private image read failed.'));
      }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { release(); } }
  });
}
const isMissing = error => error?.$metadata?.httpStatusCode === 404 || ['NoSuchKey', 'NotFound'].includes(error?.name);
const isDuplicate = error => [409, 412].includes(error?.$metadata?.httpStatusCode) || ['PreconditionFailed', 'ConditionalRequestConflict'].includes(error?.name);

export function createNeonBucket({ client, commands, bucket = 'tennis-avatars' }) {
  if (!client?.send || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(bucket) || ['PutObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand', 'GetBucketAclCommand', 'GetBucketPolicyCommand'].some(name => typeof commands?.[name] !== 'function')) throw new Error('The private Storage adapter is unavailable.');
  async function send(name, input) {
    try { return await client.send(new commands[name]({ Bucket: bucket, ...input })); }
    catch (error) {
      // Error.message and response bodies can include credentials or keys.
      const safe = new Error('Private Storage request failed.');
      if (isMissing(error)) safe.missing = true;
      if (isDuplicate(error)) safe.existingObject = true;
      if (error?.name === 'NoSuchBucketPolicy') safe.noPolicy = true;
      throw safe;
    }
  }
  async function get(key) {
    validateObjectKey(key);
    let object;
    try { object = await send('GetObjectCommand', { Key: key }); } catch (error) { if (error.missing) return null; throw error; }
    const type = object.ContentType?.split(';')[0].trim(), size = object.ContentLength ?? null;
    if (!TYPES.has(type) || (size !== null && (!Number.isSafeInteger(size) || size < 0 || size > LIMIT))) { await discardBody(object.Body); throw new Error('Private image metadata is invalid.'); }
    const body = boundedImage(object.Body);
    return { body, size, httpMetadata: { contentType: type }, arrayBuffer: () => new Response(body).arrayBuffer() };
  }
  async function put(key, value, options = {}) {
    validateObjectKey(key);
    const type = options.httpMetadata?.contentType, bytes = await imageBytes(value, type);
    // Access is controlled by the private bucket. No public ACL, presigned
    // URL, browser credential, or image redirect is ever returned.
    await send('PutObjectCommand', { Key: key, Body: bytes, ContentType: type, ContentLength: bytes.byteLength, CacheControl: 'private, no-store' });
  }
  async function remove(key) { validateObjectKey(key); await send('DeleteObjectCommand', { Key: key }); }
  async function assertPrivateAcl() {
    const acl = await send('GetBucketAclCommand', {});
    if (typeof acl.Owner?.ID !== 'string' || !acl.Owner.ID || !Array.isArray(acl.Grants) || !acl.Grants.length || acl.Grants.some(grant => grant.Permission !== 'FULL_CONTROL' || grant.Grantee?.Type !== 'CanonicalUser' || grant.Grantee.ID !== acl.Owner.ID)) throw new ImportError('The avatar and photo bucket must be private.');
    try {
      const response = await send('GetBucketPolicyCommand', {});
      let policy; try { policy = JSON.parse(response.Policy); } catch { throw new ImportError('Private bucket policy could not be verified.'); }
      // This app needs no Allow policy; branch credentials authorize access.
      if (!Array.isArray(policy.Statement) || policy.Statement.some(statement => statement.Effect !== 'Deny')) throw new ImportError('The private bucket cannot grant anonymous or external access.');
    } catch (error) { if (!error.noPolicy) throw error; }
  }
  async function immutableUpload(key, value, contentType) {
    validateObjectKey(key); const bytes = await imageBytes(value, contentType);
    try { await send('PutObjectCommand', { Key: key, Body: bytes, ContentType: contentType, ContentLength: bytes.byteLength, CacheControl: 'private, no-store', IfNoneMatch: '*' }); }
    catch (error) { throw new ImportError(error.existingObject ? 'A private image already exists; overwrite refused.' : 'Private image upload was not confirmed; staged media were retained.', { existingObject: error.existingObject === true, storageUncertain: !error.existingObject }); }
  }
  async function download(key) {
    const object = await get(key);
    if (!object) throw new ImportError('A staged private image could not be verified.');
    return { bytes: new Uint8Array(await object.arrayBuffer()), contentType: object.httpMetadata.contentType };
  }
  async function assertImportSafe() {
    await assertPrivateAcl();
    // Neon documents the core S3 operations but does not promise conditional
    // PutObject semantics. Prove non-overwrite behavior using only a fresh,
    // private canary before importing any member object or SQL row.
    const key = 'migration-capability-probe/' + randomUUID();
    const first = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...crypto.getRandomValues(new Uint8Array(16))]);
    const second = first.slice(); second[second.length - 1] ^= 1;
    let firstWritten = false;
    try {
      await immutableUpload(key, first, 'image/png'); firstWritten = true;
      let rejected = false;
      try { await immutableUpload(key, second, 'image/png'); } catch (error) { if (error.existingObject) rejected = true; else throw error; }
      const restored = await download(key);
      if (!rejected || restored.contentType !== 'image/png' || restored.bytes.length !== first.length || restored.bytes.some((byte, index) => byte !== first[index])) throw new ImportError('Storage does not enforce conditional uploads; member media import refused.');
    } finally {
      // Only this fresh capability-test key is removed. Member media staging
      // is never rolled back after uncertain or concurrent import outcomes.
      if (firstWritten) await remove(key).catch(() => {});
    }
  }
  return { put, get, delete: remove, importBucket: { assertPrivate: assertImportSafe, upload: immutableUpload, download,
    async remove(keys) { for (const key of keys) await remove(key); } } };
}
