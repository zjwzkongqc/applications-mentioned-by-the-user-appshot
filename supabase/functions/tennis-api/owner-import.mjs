import { sha256, APP_ID, FORMAT_VERSION, SCHEMA_VERSION, TABLE_NAMES } from './import.mjs';

export const OWNER_IMPORT_PATH = '/functions/v1/tennis-api/api/_owner/migration-import';
const LIMIT = 32 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const FORBIDDEN = ['Origin', 'Cookie', 'Authorization', 'X-Tennis-Session'];
const encoder = new TextEncoder();

export function importSignatureMessage({ publicOrigin, migrationId, fromApiOrigin, pageBaseUrl, digest, timestamp, nonce }) {
  return ['tennis-owner-import-v1', 'POST', OWNER_IMPORT_PATH, publicOrigin,
    migrationId, fromApiOrigin, pageBaseUrl, digest, timestamp, nonce].join('\n');
}

function json(data, status) {
  return new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
  } });
}
const hidden = () => json({ error: '页面不存在。' }, 404);

async function readBody(request) {
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > LIMIT)) throw new Error('Bounded request required.');
  if (!request.body) throw new Error('Body required.');
  const reader = request.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > LIMIT) { await reader.cancel(); throw new Error('Bounded request required.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function createOwnerImportHandler({ publicOrigin, migrationId, fromApiOrigin, pageBaseUrl, publicKey, importSnapshot, readReceipt, now = Date.now }) {
  const origin = new URL(publicOrigin), from = new URL(fromApiOrigin), page = new URL(pageBaseUrl);
  if (origin.protocol !== 'https:' || origin.origin !== publicOrigin || !/^[a-z0-9]{20}\.supabase\.co$/.test(origin.hostname) ||
      from.protocol !== 'https:' || from.origin !== fromApiOrigin || fromApiOrigin !== 'https://tennis-dazi-club-2026.divine-seal-5110.chatgpt.site' ||
      pageBaseUrl !== 'https://zjwzkongqc.github.io/applications-mentioned-by-the-user-appshot/' || page.href !== pageBaseUrl || !HASH.test(migrationId) ||
      !publicKey || publicKey.kty !== 'EC' || publicKey.crv !== 'P-256' || typeof importSnapshot !== 'function' || typeof readReceipt !== 'function') throw new Error('Private import configuration is invalid.');
  const verificationKey = crypto.subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  // A matching permanent receipt makes a lost success response safe to retry.
  // The importer serializes storage, SQL, and cleanup across runtime instances.
  const matchesReceipt = (receipt, digest) => receipt && receipt.formatVersion === FORMAT_VERSION && receipt.appId === APP_ID && receipt.schemaVersion === SCHEMA_VERSION && receipt.credentialsPreserved === true &&
    receipt.migrationId === migrationId && receipt.fromApiOrigin === fromApiOrigin && receipt.toApiOrigin === publicOrigin && receipt.pageBaseUrl === pageBaseUrl && receipt.sourceSnapshotSha256 === digest &&
    typeof receipt.importedAt === 'string' && Number.isFinite(Date.parse(receipt.importedAt)) && Number.isSafeInteger(receipt.avatarCount) && receipt.avatarCount >= 0 && receipt.tableCounts &&
    TABLE_NAMES.every(name => Number.isSafeInteger(receipt.tableCounts[name]) && receipt.tableCounts[name] >= 0) && Object.keys(receipt.tableCounts).length === TABLE_NAMES.length;
  return async request => {
    const url = new URL(request.url);
    if (url.pathname !== OWNER_IMPORT_PATH) return null;
    if (url.search || request.method !== 'POST' || FORBIDDEN.some(name => request.headers.has(name)) || request.headers.get('Content-Type') !== 'application/json' ||
        (request.headers.has('Content-Encoding') && request.headers.get('Content-Encoding').toLowerCase() !== 'identity')) return hidden();
    const digest = request.headers.get('X-Tennis-Import-SHA256'), timestamp = request.headers.get('X-Tennis-Import-Time'), nonce = request.headers.get('X-Tennis-Import-Nonce'), signature = request.headers.get('X-Tennis-Import-Signature');
    if (!HASH.test(digest || '') || !/^\d{13}$/.test(timestamp || '') || !HASH.test(nonce || '') || !/^[A-Za-z0-9_-]{86}$/.test(signature || '') || Number(timestamp) < now() - 300000 || Number(timestamp) > now() + 30000) return hidden();
    let authenticated = false;
    try {
      const bytes = Uint8Array.from(atob(signature.replaceAll('-', '+').replaceAll('_', '/') + '=='), char => char.charCodeAt(0));
      authenticated = bytes.length === 64 && await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await verificationKey, bytes,
        encoder.encode(importSignatureMessage({ publicOrigin, migrationId, fromApiOrigin, pageBaseUrl, digest, timestamp, nonce })));
    } catch { /* Invalid requests disclose no deployment state. */ }
    if (!authenticated) return hidden();
    let bodyVerified = false;
    try {
      const bytes = await readBody(request);
      if (await sha256(bytes) !== digest) return hidden();
      const snapshotJson = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      bodyVerified = true;
      const existing = await readReceipt();
      if (matchesReceipt(existing, digest)) return json({ imported: true, alreadyImported: true, receipt: existing }, 200);
      if (existing) return json({ error: '目标后台已有导入回执，请先核对。' }, 409);
      const receipt = await importSnapshot({ snapshotJson, metadata: { migrationId, fromApiOrigin, toApiOrigin: publicOrigin, pageBaseUrl, sourceSnapshotSha256: digest } });
      if (!matchesReceipt(receipt, digest)) throw new Error('Receipt verification failed.');
      return json({ imported: true, receipt }, 200);
    } catch {
      // A commit acknowledgement can be lost even after the SQL transaction
      // succeeds. Read back the exact receipt; never delete or overwrite data.
      if (bodyVerified) {
        try { const receipt = await readReceipt(); if (matchesReceipt(receipt, digest)) return json({ imported: true, alreadyImported: true, receipt }, 200); } catch { /* Keep failures private. */ }
      }
      return json({ error: '导入尚未确认，请核对后台后重试。' }, 503);
    }
  };
}
