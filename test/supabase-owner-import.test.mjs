import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createOwnerImportHandler, importSignatureMessage, OWNER_IMPORT_PATH } from '../supabase/functions/tennis-api/owner-import.mjs';
import { migrationConfig } from '../supabase/functions/tennis-api/migration-config.mjs';
import { sha256, TABLE_NAMES } from '../supabase/functions/tennis-api/import.mjs';

const ORIGIN = 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co';
const NOW = Date.parse('2026-10-04T10:00:00.000Z');
const PRIVATE_MARKER = 'postgres://private-owner:secret@private.invalid/database';
const BODY = JSON.stringify({ privateSnapshot: 'complete original data 🎾' });
const LIMIT = 32 * 1024 * 1024;
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKey = keys.publicKey.export({ format: 'jwk' });
const identity = { publicOrigin: ORIGIN, ...migrationConfig };

function receipt(digest, overrides = {}) {
  return { formatVersion: 1, appId: 'tennis-dazi-club-2026', schemaVersion: 4,
    migrationId: migrationConfig.migrationId, fromApiOrigin: migrationConfig.fromApiOrigin,
    toApiOrigin: ORIGIN, pageBaseUrl: migrationConfig.pageBaseUrl,
    sourceSnapshotSha256: digest, importedAt: new Date(NOW).toISOString(),
    credentialsPreserved: true, avatarCount: 0,
    tableCounts: Object.fromEntries(TABLE_NAMES.map(name => [name, 0])), ...overrides };
}

async function signedRequest({ body = BODY, signedBody = body, message = {}, headers = {}, method = 'POST', url = ORIGIN + OWNER_IMPORT_PATH, key = keys.privateKey } = {}) {
  const fields = { ...identity, digest: await sha256(signedBody ?? ''), timestamp: String(NOW), nonce: 'b'.repeat(64), ...message };
  const signature = sign('sha256', new TextEncoder().encode(importSignatureMessage(fields)), { key, dsaEncoding: 'ieee-p1363' });
  return new Request(url, { method, headers: { 'Content-Type': 'application/json',
    'X-Tennis-Import-SHA256': fields.digest, 'X-Tennis-Import-Time': fields.timestamp,
    'X-Tennis-Import-Nonce': fields.nonce, 'X-Tennis-Import-Signature': Buffer.from(signature).toString('base64url'), ...headers },
    ...(!['GET', 'HEAD'].includes(method) && body !== null ? { body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } : {}) });
}

function handler({ existing = null, importSnapshot, readReceipt, options = {} } = {}) {
  const calls = { imports: [], reads: 0 };
  const run = createOwnerImportHandler({ ...identity, publicKey, now: () => NOW,
    readReceipt: readReceipt ?? (async () => { calls.reads++; return existing; }),
    importSnapshot: importSnapshot ?? (async input => { calls.imports.push(input); return receipt(input.metadata.sourceSnapshotSha256); }), ...options });
  return { run, calls };
}

test('owner receiver binds a real P-256 signature to the fixed identity and exact raw body, then passes only trusted metadata', async () => {
  assert.equal(importSignatureMessage({ ...identity, digest: 'a'.repeat(64), timestamp: String(NOW), nonce: 'b'.repeat(64) }),
    ['tennis-owner-import-v1', 'POST', OWNER_IMPORT_PATH, ORIGIN, migrationConfig.migrationId,
      migrationConfig.fromApiOrigin, migrationConfig.pageBaseUrl, 'a'.repeat(64), String(NOW), 'b'.repeat(64)].join('\n'));
  const h = handler();
  const response = await h.run(await signedRequest());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.imported, true);
  assert.equal(result.receipt.sourceSnapshotSha256, await sha256(BODY));
  assert.equal(h.calls.imports.length, 1);
  assert.deepEqual(h.calls.imports[0], { snapshotJson: BODY, metadata: {
    migrationId: migrationConfig.migrationId, fromApiOrigin: migrationConfig.fromApiOrigin,
    toApiOrigin: ORIGIN, pageBaseUrl: migrationConfig.pageBaseUrl, sourceSnapshotSha256: await sha256(BODY) } });
  for (const [name, value] of [['Cache-Control', 'no-store'], ['X-Content-Type-Options', 'nosniff'], ['Referrer-Policy', 'no-referrer']]) assert.equal(response.headers.get(name), value);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('altering any signed purpose tuple or using a different signing key rejects before reading the snapshot or database', async () => {
  const changes = [{ publicOrigin: 'https://bbbbbbbbbbbbbbbbbbbb.supabase.co' },
    { migrationId: 'f'.repeat(64) }, { fromApiOrigin: 'https://other.example' },
    { pageBaseUrl: 'https://other.github.io/' }, { digest: 'e'.repeat(64) }];
  for (const message of changes) {
    const h = handler();
    assert.equal((await h.run(await signedRequest({ message }))).status, 404);
    assert.deepEqual(h.calls, { imports: [], reads: 0 });
  }
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const h = handler();
  assert.equal((await h.run(await signedRequest({ key: other.privateKey }))).status, 404);
  assert.deepEqual(h.calls, { imports: [], reads: 0 });
});

test('signed timestamps have a bounded freshness window and malformed nonce/signature headers fail closed', async () => {
  for (const timestamp of [String(NOW - 300001), String(NOW + 30001), '0' + String(NOW), 'not-a-time']) {
    const h = handler();
    assert.equal((await h.run(await signedRequest({ message: { timestamp } }))).status, 404);
    assert.equal(h.calls.reads, 0);
  }
  for (const headers of [{ 'X-Tennis-Import-Nonce': 'B'.repeat(64) }, { 'X-Tennis-Import-Nonce': 'b'.repeat(63) },
    { 'X-Tennis-Import-Nonce': 'c'.repeat(64) }, { 'X-Tennis-Import-Time': String(NOW + 1) },
    { 'X-Tennis-Import-Signature': 'a'.repeat(85) }, { 'X-Tennis-Import-Signature': 'a'.repeat(86) }, { 'X-Tennis-Import-SHA256': 'E'.repeat(64) }]) {
    const h = handler();
    assert.equal((await h.run(await signedRequest({ headers }))).status, 404);
    assert.deepEqual(h.calls, { imports: [], reads: 0 });
  }
  for (const timestamp of [String(NOW - 300000), String(NOW + 30000)]) assert.equal((await handler().run(await signedRequest({ message: { timestamp } }))).status, 200);
});

test('the owner route forbids browser/session headers, query parameters, other methods and noncanonical content types', async () => {
  for (const name of ['Origin', 'Cookie', 'Authorization', 'X-Tennis-Session']) {
    const h = handler();
    assert.equal((await h.run(await signedRequest({ headers: { [name]: '' } }))).status, 404);
    assert.deepEqual(h.calls, { imports: [], reads: 0 });
  }
  for (const change of [{ url: ORIGIN + OWNER_IMPORT_PATH + '?token=private' }, { method: 'GET' },
    { headers: { 'Content-Type': 'application/json; charset=utf-8' } }, { headers: { 'Content-Encoding': 'gzip' } }]) {
    const h = handler();
    assert.equal((await h.run(await signedRequest(change))).status, 404);
    assert.deepEqual(h.calls, { imports: [], reads: 0 });
  }
  assert.equal(await handler().run(new Request(ORIGIN + '/functions/v1/tennis-api/healthz')), null);
});

test('a captured signature cannot authenticate different raw bytes and failed authentication never pulls the request stream', async () => {
  const h = handler({ existing: receipt(await sha256(BODY)) });
  assert.equal((await h.run(await signedRequest({ body: BODY + ' ', signedBody: BODY }))).status, 404);
  assert.deepEqual(h.calls, { imports: [], reads: 0 });
  let pulls = 0;
  const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode(BODY)); controller.close(); } }, { highWaterMark: 0 });
  const denied = handler();
  assert.equal((await denied.run(await signedRequest({ body, signedBody: BODY, headers: { 'X-Tennis-Import-Signature': 'a'.repeat(86) } }))).status, 404);
  assert.equal(pulls, 0);
  assert.deepEqual(denied.calls, { imports: [], reads: 0 });
});

test('only the exact complete receipt makes a verified replay idempotent; differing or incomplete receipts never call import', async () => {
  const digest = await sha256(BODY), original = receipt(digest);
  const h = handler({ existing: original });
  const result = await (await h.run(await signedRequest())).json();
  assert.deepEqual(result, { imported: true, alreadyImported: true, receipt: original });
  assert.equal(h.calls.imports.length, 0);
  const invalid = [ { sourceSnapshotSha256: 'e'.repeat(64) }, { migrationId: 'f'.repeat(64) },
    { fromApiOrigin: 'https://other.example' }, { toApiOrigin: 'https://other.example' },
    { pageBaseUrl: 'https://other.github.io/' }, { credentialsPreserved: false },
    { avatarCount: -1 }, { importedAt: 'invalid' },
    { tableCounts: { ...original.tableCounts, extra: 0 } }, { tableCounts: { accounts: 0 } } ];
  for (const change of invalid) {
    const denied = handler({ existing: receipt(digest, change) });
    assert.equal((await denied.run(await signedRequest())).status, 409);
    assert.equal(denied.calls.imports.length, 0);
  }
});

test('an import with a lost commit acknowledgement succeeds only after readback of the exact permanent receipt', async () => {
  const digest = await sha256(BODY); let reads = 0, imports = 0;
  const h = handler({ readReceipt: async () => ++reads === 1 ? null : receipt(digest),
    importSnapshot: async () => { imports++; throw new Error(PRIVATE_MARKER); } });
  const response = await h.run(await signedRequest());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).alreadyImported, true);
  assert.equal(reads, 2); assert.equal(imports, 1);
});

test('database, validation and private transport failures never disclose private error values or false success', async () => {
  const digest = await sha256(BODY);
  for (const change of [ { readReceipt: async () => { throw new Error(PRIVATE_MARKER); } },
    { importSnapshot: async () => { throw new Error(PRIVATE_MARKER); } },
    { importSnapshot: async () => receipt(digest, { credentialsPreserved: false }) } ]) {
    const response = await handler(change).run(await signedRequest());
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(text.includes(PRIVATE_MARKER), false);
    assert.equal(text.includes('imported'), false);
  }
});

test('body failures never become success through an existing matching receipt before raw-byte verification', async () => {
  const invalidUtf8 = Uint8Array.of(0xc3, 0x28);
  const cases = [{ body: null, signedBody: BODY },
    { headers: { 'Content-Length': String(LIMIT + 1) } },
    { headers: { 'Content-Length': '-1' } }, { body: invalidUtf8, signedBody: invalidUtf8 },
    { body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(LIMIT + 1)); controller.close(); } }), signedBody: BODY }];
  for (const input of cases) {
    const digest = await sha256(input.signedBody ?? BODY);
    const h = handler({ existing: receipt(digest) });
    const response = await h.run(await signedRequest(input));
    assert.notEqual(response.status, 200);
    assert.equal(h.calls.reads, 0);
    assert.equal(h.calls.imports.length, 0);
  }
});

test('missing or conflicting trusted deployment identity cannot initialize an import handler', () => {
  const dependencies = { ...identity, publicKey, now: () => NOW, readReceipt: async () => null, importSnapshot: async () => null };
  for (const change of [{ migrationId: undefined }, { publicOrigin: 'https://not-a-project.example' },
    { publicOrigin: ORIGIN + '/' }, { fromApiOrigin: 'https://attacker.example' },
    { pageBaseUrl: 'https://attacker.github.io/' }, { publicKey: null }, { importSnapshot: null }, { readReceipt: null }]) {
    assert.throws(() => createOwnerImportHandler({ ...dependencies, ...change }));
  }
});
