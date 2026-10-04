import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createOwnerImportHandler, importSignatureMessage, OWNER_IMPORT_PATH } from '../supabase/functions/tennis-api/owner-import.mjs';
import { migrationConfig } from '../supabase/functions/tennis-api/migration-config.mjs';
import { sha256, TABLE_NAMES, SCHEMA_VERSION, ImportError, importPrivateSnapshot, validateSnapshot, snapshotChecksum } from '../supabase/functions/tennis-api/import.mjs';
import { validateBackup, snapshotChecksum as nodeSnapshotChecksum } from '../scripts/backup-format.mjs';

const ORIGIN = 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co';
const NOW = Date.parse('2026-10-04T10:00:00.000Z');
const PRIVATE_MARKER = 'postgres://private-owner:secret@private.invalid/database';
const BODY = JSON.stringify({ privateSnapshot: 'complete original data 🎾' });
const LIMIT = 32 * 1024 * 1024;
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKey = keys.publicKey.export({ format: 'jwk' });
const identity = { publicOrigin: ORIGIN, ...migrationConfig };
const SCHEMA5_TABLE_NAMES = ['accounts', 'account_credentials', 'clubs', 'members', 'account_sessions',
  'club_invites', 'auth_failures', 'auth_registrations', 'records', 'monthly_ratings',
  'record_photos', 'audit_events', 'culture', 'cheers', 'checkins'];

function receipt(digest, overrides = {}) {
  return { formatVersion: 1, appId: 'tennis-dazi-club-2026', schemaVersion: 5,
    migrationId: migrationConfig.migrationId, fromApiOrigin: migrationConfig.fromApiOrigin,
    toApiOrigin: ORIGIN, pageBaseUrl: migrationConfig.pageBaseUrl,
    sourceSnapshotSha256: digest, importedAt: new Date(NOW).toISOString(),
    credentialsPreserved: true, avatarCount: 0,
    tableCounts: Object.fromEntries(SCHEMA5_TABLE_NAMES.map(name => [name, 0])), ...overrides };
}

async function schema5Fixture() {
  const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  const time = new Date(NOW).toISOString(), tables = Object.fromEntries(SCHEMA5_TABLE_NAMES.map(name => [name, []]));
  const avatarKey = `avatars/${id(10)}/${id(20)}/${id(100)}`, photoKey = `photos/${id(10)}/${id(21)}/${id(40)}`;
  const avatarBytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 7, 9);
  const photoBytes = Uint8Array.of(...avatarBytes, 11, 13);
  tables.accounts = [1, 2].map(n => ({ id: id(n), display_name: n === 1 ? '原管理员' : '已移除球友', recovery_hash: String(n).repeat(64), created_at: time }));
  tables.account_credentials = [{ account_id: id(1), email: 'original-private-login@example.test', password_hash: 'b'.repeat(64), password_salt: 'c'.repeat(32), updated_at: time }];
  tables.clubs = [{ id: id(10), invite_hash: '3'.repeat(64), name: '原小组', slogan: '完整保留历史 🎾', owner_id: id(20), created_at: time, invite_revoked_at: time }];
  tables.members = [
    { id: id(20), club_id: id(10), account_id: id(1), session_hash: '5'.repeat(64), nickname: '原管理员', avatar_key: avatarKey, bio: '公开球员卡仅含简介和月評', created_at: time, removed_at: null, public_share_hash: '9'.repeat(64) },
    { id: id(21), club_id: id(10), account_id: id(2), session_hash: '6'.repeat(64), nickname: '已移除球友', avatar_key: null, bio: '记录、照片和月评仍在', created_at: time, removed_at: time, public_share_hash: null }
  ];
  tables.account_sessions = [{ session_hash: '7'.repeat(64), account_id: id(1), expires_at: NOW + 180 * 86400000, created_at: time },
    { session_hash: '8'.repeat(64), account_id: id(2), expires_at: NOW - 1, created_at: time }];
  tables.club_invites = [{ invite_hash: '4'.repeat(64), club_id: id(10), created_at: time, revoked_at: time, expires_at: 0 },
    { invite_hash: 'd'.repeat(64), club_id: id(10), created_at: time, revoked_at: null, expires_at: NOW + 7 * 86400000 }];
  tables.auth_failures = [{ key: 'ip:' + 'f'.repeat(64), window_start: NOW, failures: 29 }];
  tables.auth_registrations = [{ account_id: id(1), club_id: id(10), legacy_hash: '5'.repeat(64), nonce_hash: 'a'.repeat(64), expires_at: NOW + 3600000 }];
  const unrated = { forehand: null, backhand: null, serve: null, return_skill: null, net: null, footwork: null };
  const partial = { forehand: 0, backhand: null, serve: 10, return_skill: null, net: null, footwork: 3 };
  const record = { club_id: id(10), play_date: '2026-09-30', minutes: 90, partners: '老搭子', venue: '原球场', mood: '认真练球', note: '保留换行\n训练历史', created_at: time,
    training_projects: '["backhand","serve"]', training_content: '原训练内容', training_effect: 'some', effect_note: '原心得', next_plan: '原计划' };
  tables.records = [{ ...record, id: id(30), member_id: id(20), ...partial }, { ...record, id: id(31), member_id: id(21), ...unrated }];
  tables.monthly_ratings = [{ member_id: id(20), month: '2026-08', ...partial, created_at: time, updated_at: time },
    { member_id: id(20), month: '2026-09', ...unrated, created_at: time, updated_at: time },
    { member_id: id(21), month: '2026-07', ...Object.fromEntries(Object.keys(unrated).map(name => [name, 0])), created_at: time, updated_at: time }];
  tables.record_photos = [{ id: id(40), club_id: id(10), member_id: id(21), record_id: id(31), object_key: photoKey, content_type: 'image/png', byte_size: photoBytes.byteLength, created_at: time }];
  const audits = [['create-invite', 'additional', '{}'], ['revoke-invite', 'original', '{}'],
    ['edit-profile', id(21), '{"before":{"nickname":"旧昵称"},"after":{"nickname":"已移除球友"}}'],
    ['edit-rating', id(21), '{"month":"2026-07","before":null,"after":{"forehand":0,"backhand":null}}'],
    ['remove-member', id(21), '{}'], ['restore-member', id(21), '{}'],
    ['delete-photo', id(41), '{}'], ['delete-record', id(42), '{"author":"' + id(21) + '"}'], ['export-backup', id(10), '{}']];
  tables.audit_events = audits.map(([action, target_id, details], n) => ({ id: id(50 + n), club_id: id(10), actor_member_id: id(20), action, target_id, details, created_at: time }));
  tables.culture = [{ id: id(70), club_id: id(10), member_id: id(21), content: '被移除成员的历史群内梗', created_at: time }];
  tables.cheers = [{ record_id: id(30), member_id: id(21), emoji: '🎾' }];
  tables.checkins = [{ id: id(71), club_id: id(10), member_id: id(21), checkin_date: '2026-09-30', created_at: time }];
  const media = new Map([[avatarKey, avatarBytes], [photoKey, photoBytes]]);
  const avatars = await Promise.all([...media].map(async ([key, bytes]) => ({ key, contentType: 'image/png', dataBase64: Buffer.from(bytes).toString('base64'), sha256: await sha256(bytes) })));
  const snapshot = { formatVersion: 1, appId: 'tennis-dazi-club-2026', schemaVersion: 5, createdAt: time, fromApiOrigin: migrationConfig.fromApiOrigin, tables, avatars };
  snapshot.checksum = await snapshotChecksum(snapshot);
  return { snapshot, media, avatarKey, photoKey };
}

function privateTarget() {
  const target = { rows: Object.fromEntries(SCHEMA5_TABLE_NAMES.map(name => [name, []])), receipt: null, objects: new Map(), events: [] };
  const assertEmpty = async () => { if (target.receipt || Object.values(target.rows).some(rows => rows.length)) throw new ImportError('nonempty private target'); };
  const db = { async verifySchema() { target.events.push('schema'); }, assertEmpty,
    async transaction(callback) {
      const pendingRows = Object.fromEntries(SCHEMA5_TABLE_NAMES.map(name => [name, []])); let pendingReceipt;
      target.events.push('begin');
      await callback({ assertEmpty,
        async insertRows(name, rows) { pendingRows[name] = structuredClone(rows); },
        async readRows(name) { return structuredClone(pendingRows[name]); },
        async writeReceipt(value) { pendingReceipt = structuredClone(value); target.events.push('receipt'); } });
      target.rows = pendingRows; target.receipt = pendingReceipt; target.events.push('commit');
    }
  };
  const bucket = { async assertPrivate() { target.events.push('private'); },
    async upload(key, bytes, contentType) { if (target.objects.has(key)) throw new ImportError('existing private object', { existingObject: true }); target.objects.set(key, { bytes: new Uint8Array(bytes), contentType }); target.events.push('upload'); },
    async download(key) { return target.objects.get(key); },
    async remove() { throw new Error('A receiver import must retain private stages, never delete them.'); }
  };
  return { target, db, bucket };
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

test('a signed schema 5 snapshot preserves all 15 tables, credentials, partial monthly scores, private photos and historical audit targets', async () => {
  assert.equal(SCHEMA_VERSION, 5);
  assert.deepEqual(TABLE_NAMES, SCHEMA5_TABLE_NAMES);
  const { snapshot, media, avatarKey, photoKey } = await schema5Fixture();
  const validated = await validateSnapshot(snapshot);
  const nodeValidated = validateBackup(snapshot);
  assert.equal(nodeSnapshotChecksum(snapshot), snapshot.checksum);
  assert.deepEqual(nodeValidated.tableCounts, validated.tableCounts);
  assert.equal(nodeValidated.avatarCount, validated.avatarCount);
  assert.equal(validated.avatarCount, 2);
  assert.deepEqual([...validated.avatars.keys()].sort(), [...media.keys()].sort());
  const { target, db, bucket } = privateTarget(); let imports = 0;
  const h = handler({ readReceipt: async () => target.receipt,
    importSnapshot: async input => { imports++; return importPrivateSnapshot({ ...input, db, bucket }); } });
  const body = JSON.stringify(snapshot), request = await signedRequest({ body });
  const response = await h.run(request.clone());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.imported, true);
  assert.equal(result.receipt.schemaVersion, 5);
  assert.equal(result.receipt.avatarCount, 2, 'avatarCount includes the avatar and the private record photo');
  assert.equal(Object.hasOwn(result.receipt, 'photoCount'), false);
  assert.deepEqual(result.receipt.tableCounts, Object.fromEntries(SCHEMA5_TABLE_NAMES.map(name => [name, snapshot.tables[name].length])));
  assert.deepEqual(target.rows, snapshot.tables);
  assert.deepEqual(target.receipt, result.receipt);
  assert.deepEqual(target.events.slice(-2), ['receipt', 'commit']);
  assert.equal(target.objects.size, 2);
  for (const [key, bytes] of media) assert.deepEqual(target.objects.get(key), { bytes, contentType: 'image/png' });
  assert.equal(target.rows.monthly_ratings[0].forehand, 0);
  assert.equal(target.rows.monthly_ratings[0].backhand, null);
  assert.equal(target.rows.monthly_ratings[1].forehand, null);
  assert.equal(target.rows.members[1].removed_at, snapshot.createdAt);
  assert.equal(target.rows.club_invites[0].expires_at, 0);
  assert.equal(target.rows.record_photos[0].object_key, photoKey);
  assert.equal(target.rows.members[0].avatar_key, avatarKey);
  const encoded = JSON.stringify(result);
  for (const privateValue of ['password_hash', 'password_salt', 'original-private-login@example.test', photoKey, avatarKey]) assert.equal(encoded.includes(privateValue), false);
  assert.deepEqual(await (await h.run(request.clone())).json(), { imported: true, alreadyImported: true, receipt: target.receipt });
  assert.equal(imports, 1);
});

test('signed incomplete schema 5 snapshots fail before any database or Storage access, including missing photos and cross-club references', async () => {
  const mutations = [snapshot => { delete snapshot.tables.account_credentials; },
    snapshot => { delete snapshot.tables.members[0].public_share_hash; },
    snapshot => { snapshot.tables.monthly_ratings[0].forehand = -1; },
    snapshot => { snapshot.tables.monthly_ratings[0].month = '2026-13'; },
    snapshot => { snapshot.tables.monthly_ratings.push(structuredClone(snapshot.tables.monthly_ratings[0])); },
    snapshot => { snapshot.tables.account_credentials[0].password_salt = 'short'; },
    snapshot => { snapshot.tables.account_credentials[0].account_id = '00000000-0000-4000-8000-000000999999'; },
    snapshot => { snapshot.tables.record_photos[0].member_id = snapshot.tables.members[0].id; },
    snapshot => { snapshot.tables.record_photos[0].byte_size++; },
    snapshot => { snapshot.avatars.pop(); },
    snapshot => { snapshot.tables.audit_events[0].actor_member_id = '00000000-0000-4000-8000-000000999999'; }];
  for (const mutate of mutations) {
    const { snapshot } = await schema5Fixture();
    mutate(snapshot); snapshot.checksum = await snapshotChecksum(snapshot);
    assert.throws(() => validateBackup(snapshot));
    const { target, db, bucket } = privateTarget();
    const h = handler({ importSnapshot: input => importPrivateSnapshot({ ...input, db, bucket }) });
    const response = await h.run(await signedRequest({ body: JSON.stringify(snapshot) }));
    assert.equal(response.status, 503);
    assert.deepEqual(target.events, []);
    assert.equal(target.objects.size, 0);
    assert.equal(target.receipt, null);
  }
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
    { schemaVersion: 4 }, { avatarCount: -1 }, { importedAt: 'invalid' },
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
