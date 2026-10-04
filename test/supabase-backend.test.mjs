import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { translateSql, safeInteger, postgresOptions, createPostgresDatabase } from '../supabase/functions/tennis-api/postgres.mjs';
import { createSupabaseBucket } from '../supabase/functions/tennis-api/storage.mjs';
import { createEdgeHandler } from '../supabase/functions/tennis-api/handler.mjs';
import worker from '../src/worker.js';

const ORIGIN = 'https://tennis-test.supabase.co';
const PAGES = 'https://zjwzkongqc.github.io';
const PAGE_BASE = PAGES + '/applications-mentioned-by-the-user-appshot/';
const PREFIX = '/functions/v1/tennis-api';
const SERVICE_KEY = 'test-server-only-storage-key';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const nonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const hash = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');
const DATA_TABLES = ['accounts', 'account_credentials', 'account_sessions', 'auth_failures', 'auth_registrations', 'clubs', 'club_invites', 'members', 'records', 'monthly_ratings', 'record_photos', 'audit_events', 'checkins', 'cheers', 'culture'];
const MIGRATION_ID = 'a'.repeat(64), FROM_ORIGIN = 'https://original-tennis.example';
const migrationConfig = { publicOrigin: ORIGIN, migrationId: MIGRATION_ID, migrationFromOrigin: FROM_ORIGIN, migrationPageBaseUrl: PAGE_BASE };

function migrationReceipt(overrides = {}) {
  return {
    formatVersion: 1, appId: 'tennis-dazi-club-2026', schemaVersion: 5, migrationId: MIGRATION_ID,
    fromApiOrigin: FROM_ORIGIN, toApiOrigin: ORIGIN, pageBaseUrl: PAGE_BASE, credentialsPreserved: true,
    sourceSnapshotSha256: 'b'.repeat(64), importedAt: new Date().toISOString(),
    tableCounts: Object.fromEntries(DATA_TABLES.map(table => [table, 0])), avatarCount: 0, ...overrides
  };
}

function request(path, { method = 'GET', body, rawBody, headers = {}, origin = PAGES, prefix = true } = {}) {
  return new Request(ORIGIN + (prefix ? PREFIX : '') + path, {
    method, headers: { Origin: origin, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? rawBody : JSON.stringify(body)
  });
}

test('Postgres translation preserves literals and comments while binding identities and scalar MAX correctly', () => {
  const translated = translateSql(`SELECT '?' AS literal, "?" FROM members WHERE session_hash=? AND (? IS NULL OR account_id=?) -- ?\n/* ? */ AND nickname='it''s ?'`);
  assert.equal(translated.parameters, 3);
  assert.equal(translated.sql, `SELECT '?' AS literal, "?" FROM members WHERE session_hash=$1 AND ($2::text IS NULL OR account_id=$3) -- ?\n/* ? */ AND nickname='it''s ?'`);
  assert.equal(translateSql('UPDATE auth_failures SET failures=MAX(failures-1,0) WHERE key=?').sql, 'UPDATE auth_failures SET failures=GREATEST(failures-1,0) WHERE key=$1');
  assert.equal(translateSql('SELECT MAX(minutes) FROM records WHERE member_id=?').sql, 'SELECT MAX(minutes) FROM records WHERE member_id=$1');
  assert.throws(() => translateSql(null), TypeError);
  assert.equal(safeInteger('9007199254740991'), Number.MAX_SAFE_INTEGER);
  for (const value of ['9007199254740992', '1.5', 'not-a-number']) assert.throws(() => safeInteger(value));
  const options = postgresOptions();
  assert.equal(options.max, 1);
  assert.equal(options.prepare, false);
  assert.equal(options.types.bigint.parse('42'), 42);
  assert.equal(options.types.numeric.parse('5.25'), 5.25);
  assert.throws(() => options.types.numeric.parse('Infinity'));
});

test('D1-compatible statements bind hostile text separately, report row counts, and reject malformed parameters before transport', async () => {
  const calls = [];
  const connection = {
    async unsafe(sql, values) { calls.push({ sql, values }); return Object.assign([{ value: 7 }], { count: 1 }); },
    async begin(options, callback) { assert.equal(options, 'isolation level serializable'); return callback(this); }
  };
  const DB = createPostgresDatabase(connection);
  const hostile = "x'); DROP TABLE members; --";
  const statement = DB.prepare('UPDATE members SET nickname=? WHERE id=?').bind(hostile, 'member-id');
  assert.equal((await statement.run()).meta.changes, 1);
  assert.deepEqual(calls[0], { sql: 'UPDATE members SET nickname=$1 WHERE id=$2', values: [hostile, 'member-id'] });
  assert.equal(await DB.prepare('SELECT ? AS value').bind(7).first('value'), 7);
  assert.deepEqual((await DB.prepare('SELECT ? AS value').bind(7).all()).results, [{ value: 7 }]);
  const previous = calls.length;
  for (const values of [[], ['extra', 'extra'], [{}], [undefined], [NaN], [Number.MAX_SAFE_INTEGER + 1]]) {
    await assert.rejects(() => DB.prepare('SELECT ?').bind(...values).run(), TypeError);
  }
  assert.equal(calls.length, previous);
});

test('batch execution uses one driver transaction and errors discard raw database details', async () => {
  const events = [];
  const connection = {
    async unsafe() { throw new Error('Batch must use its transaction connection'); },
    async begin(options, callback) {
      assert.equal(options, 'isolation level serializable');
      events.push('begin');
      try {
        const result = await callback({ async unsafe(sql) {
          events.push(sql);
          if (sql.includes('broken')) throw Object.assign(new Error('private detail ' + SERVICE_KEY), { code: '23505', detail: 'submitted secret' });
          return Object.assign([], { count: 2 });
        } });
        events.push('commit'); return result;
      } catch (error) { events.push('rollback'); throw error; }
    }
  };
  const DB = createPostgresDatabase(connection);
  const results = await DB.batch([DB.prepare('UPDATE first SET value=?').bind(1), DB.prepare('DELETE FROM second WHERE value=?').bind(2)]);
  assert.deepEqual(results.map(result => result.meta.changes), [2, 2]);
  assert.deepEqual(events, ['begin', 'UPDATE first SET value=$1', 'DELETE FROM second WHERE value=$1', 'commit']);
  events.length = 0;
  await assert.rejects(() => DB.batch([DB.prepare('UPDATE first SET value=?').bind(1), DB.prepare('INSERT INTO broken(value) VALUES(?)').bind(2)]), error => /UNIQUE constraint/.test(error.message) && !error.message.includes(SERVICE_KEY) && error.code === '23505');
  assert.equal(events.at(-1), 'rollback');
  const other = createPostgresDatabase(connection);
  await assert.rejects(() => DB.batch([other.prepare('SELECT 1')]), TypeError);
  const failed = createPostgresDatabase({ async unsafe() { throw Object.assign(new Error('postgres://user:private-password@host/database ' + SERVICE_KEY), { code: '08006' }); }, begin: connection.begin });
  await assert.rejects(() => failed.prepare('SELECT 1').first(), error => error.message === 'Backend database query failed.' && error.code === '08006' && error.cause === undefined);
});

test('private Storage requests authenticate on the fixed origin, encode object keys, and forbid redirects', async () => {
  const calls = [];
  const bucket = createSupabaseBucket({ url: ORIGIN, serviceRoleKey: SERVICE_KEY, fetch: async (url, options) => {
    calls.push({ url, options });
    if (!options.method) return new Response(PNG, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(PNG.length) } });
    return new Response('{}', { status: 200 });
  } });
  const key = 'avatars/club/member/key?x=1#fragment';
  await bucket.put(key, PNG, { httpMetadata: { contentType: 'image/png' } });
  const avatar = await bucket.get(key);
  assert.equal(avatar.httpMetadata.contentType, 'image/png');
  assert.deepEqual(Buffer.from(await new Response(avatar.body).arrayBuffer()), PNG);
  await bucket.delete(key);
  for (const call of calls) {
    const url = new URL(call.url);
    assert.equal(url.origin, ORIGIN);
    assert.equal(url.search, ''); assert.equal(url.hash, '');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers.apikey, SERVICE_KEY);
    assert.equal(call.options.headers.Authorization, 'Bearer ' + SERVICE_KEY);
    assert.equal(call.url.includes(SERVICE_KEY), false);
  }
  assert.match(calls[0].url, /key%3Fx%3D1%23fragment$/);
  assert.match(calls[1].url, /\/object\/authenticated\/tennis-avatars\//);
  assert.deepEqual(JSON.parse(calls[2].options.body), { prefixes: [key] });
});

test('Storage validates keys and metadata before access and errors never disclose transport credentials', async () => {
  let calls = 0;
  const bucket = createSupabaseBucket({ url: ORIGIN, serviceRoleKey: SERVICE_KEY, fetch: async () => { calls++; return new Response(null, { status: 404 }); } });
  for (const invalid of ['../outside', '/absolute', 'avatars/../outside', 'avatars\\outside', '', 'avatars//outside']) {
    await assert.rejects(() => bucket.get(invalid));
    await assert.rejects(() => bucket.delete(invalid));
    await assert.rejects(() => bucket.put(invalid, PNG, { httpMetadata: { contentType: 'image/png' } }));
  }
  await assert.rejects(() => bucket.put('valid', Buffer.alloc(2 * 1024 * 1024 + 1), { httpMetadata: { contentType: 'image/png' } }));
  await assert.rejects(() => bucket.put('valid', PNG, { httpMetadata: { contentType: 'text/html' } }));
  assert.equal(calls, 0);
  assert.equal(await bucket.get('missing'), null);
  for (const url of ['https://user:password@tennis-test.supabase.co', ORIGIN + '/path', ORIGIN + '?key=secret', ORIGIN + '#secret', 'http://tennis-test.supabase.co']) assert.throws(() => createSupabaseBucket({ url, serviceRoleKey: SERVICE_KEY }));
  for (const response of [new Response(null, { status: 302, headers: { Location: 'https://attacker.test' } }), new Response('private body ' + SERVICE_KEY, { status: 500 }), new Response(PNG, { headers: { 'Content-Type': 'text/html' } }), new Response(PNG, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(2 * 1024 * 1024 + 1) } })]) {
    const failed = createSupabaseBucket({ url: ORIGIN, serviceRoleKey: SERVICE_KEY, fetch: async () => response });
    await assert.rejects(() => failed.get('valid'), error => !error.message.includes(SERVICE_KEY));
  }
  const transport = createSupabaseBucket({ url: ORIGIN, serviceRoleKey: SERVICE_KEY, fetch: async () => { throw new Error('transport leaked ' + SERVICE_KEY); } });
  for (const run of [() => transport.get('valid'), () => transport.put('valid', PNG, { httpMetadata: { contentType: 'image/png' } }), () => transport.delete('valid')]) {
    await assert.rejects(run, error => !error.message.includes(SERVICE_KEY) && error.cause === undefined);
  }
});

test('private photo Storage supports backup arrayBuffer reads and bounds unknown-length streams without leaking upstream errors', async () => {
  const photoKey = 'photos/' + crypto.randomUUID() + '/' + crypto.randomUUID() + '/' + crypto.randomUUID();
  const valid = createSupabaseBucket({ url: ORIGIN, serviceRoleKey: SERVICE_KEY, fetch: async url => {
    assert.equal(url, ORIGIN + '/storage/v1/object/authenticated/tennis-avatars/' + photoKey);
    return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
  } });
  const image = await valid.get(photoKey);
  assert.equal(image.size, null); assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
  let cancelled = false;
  const oversized = createSupabaseBucket({ url: ORIGIN, serviceRoleKey: SERVICE_KEY, fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; }
  }), { headers: { 'Content-Type': 'image/png' } }) });
  const tooLarge = await oversized.get(photoKey);
  await assert.rejects(() => tooLarge.arrayBuffer(), error => error.message === 'Private image read failed.' && !error.message.includes(SERVICE_KEY));
  assert.equal(cancelled, true);
  const upstream = createSupabaseBucket({ url: ORIGIN, serviceRoleKey: SERVICE_KEY, fetch: async () => new Response(new ReadableStream({
    pull() { throw new Error('upstream secret ' + SERVICE_KEY); }
  }), { headers: { 'Content-Type': 'image/png' } }) });
  const broken = await upstream.get(photoKey);
  await assert.rejects(() => broken.arrayBuffer(), error => error.message === 'Private image read failed.' && error.cause === undefined);
});

function fakeDatabase(metadata = migrationReceipt()) {
  return { prepare(sql) { return { bind() { return this; }, async first() { return sql.includes('tennis_migration_receipt') ? metadata ? { metadata } : null : { ok: 1 }; } }; } };
}

test('the Edge handler strips only its exact prefix, redirects its root, and ignores client IP spoofing', async () => {
  const seen = [];
  const handler = createEdgeHandler({ ...migrationConfig, DB: fakeDatabase(), BUCKET: {}, worker: { async fetch(input) {
    seen.push(input);
    const response = new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    response.headers.append('Set-Cookie', 'tc_session=sample; Path=/; HttpOnly; Secure');
    response.headers.append('Set-Cookie', 'tc_registration_legacy=sample; Path=/api/auth/register; HttpOnly; Secure');
    return response;
  } } });
  const success = await handler(request('/api/board?month=2026-01', { headers: { 'CF-Connecting-IP': '198.51.100.1', 'X-Forwarded-For': '203.0.113.1' } }));
  assert.equal(success.status, 200);
  assert.deepEqual(success.headers.getSetCookie(), ['tc_session=sample; Path=/; HttpOnly; Secure', 'tc_registration_legacy=sample; Path=' + PREFIX + '/api/auth/register; HttpOnly; Secure']);
  assert.deepEqual(await (await handler(request('/healthz'))).json(), { ok: true, maintenance: false });
  assert.equal(new URL(seen[0].url).origin, ORIGIN);
  assert.equal(new URL(seen[0].url).pathname, '/api/board');
  assert.equal(new URL(seen[0].url).search, '?month=2026-01');
  const firstAddress = seen[0].headers.get('CF-Connecting-IP');
  await handler(request('/api/board', { headers: { 'CF-Connecting-IP': '198.51.100.2', 'X-Forwarded-For': '203.0.113.2' } }));
  assert.equal(seen[1].headers.get('CF-Connecting-IP'), firstAddress);
  assert.notEqual(firstAddress, '198.51.100.1');
  assert.notEqual(firstAddress, '198.51.100.2');
  const before = seen.length;
  for (const path of ['/app.js', '/style.css']) assert.equal((await handler(request(path))).status, 404);
  assert.equal((await handler(request('/api/board', { prefix: false }))).status, 404);
  assert.equal((await handler(new Request(ORIGIN + PREFIX + '-wrong/api/board'))).status, 404);
  const root = await handler(request('/'));
  assert.equal(root.status, 302); assert.equal(root.headers.get('Location'), PAGE_BASE);
  assert.equal(seen.length, before);
  const denied = await handler(request('/api/clubs', { method: 'POST', origin: 'https://attacker.test', body: {}, headers: { Connection: 'Origin' } }));
  assert.equal(denied.status, 403); assert.equal(seen.length, before);
});

test('Edge maintenance and size limits return readable errors without touching worker or database', async () => {
  let calls = 0;
  const forbidden = { async fetch() { calls++; throw new Error('must not touch worker'); } };
  const maintenance = createEdgeHandler({ publicOrigin: ORIGIN, maintenanceMode: true, worker: forbidden });
  assert.deepEqual(await (await maintenance(request('/healthz'))).json(), { ok: true, maintenance: true });
  for (const [path, method] of [['/api/board', 'GET'], ['/api/migration', 'GET'], ['/api/migration/validate', 'POST'], ['/api/profile', 'OPTIONS']]) {
    const response = await maintenance(request(path, { method, ...(method === 'POST' ? { body: {} } : {}) }));
    assert.equal(response.status, 503); assert.equal(response.headers.get('Access-Control-Allow-Origin'), PAGES);
    assert.equal(response.headers.get('Set-Cookie'), null);
  }
  assert.equal(calls, 0);
  const handler = createEdgeHandler({ ...migrationConfig, DB: fakeDatabase(), BUCKET: {}, worker: forbidden });
  for (const [path, rawBody, type] of [['/api/profile', 'x'.repeat(20001), 'application/json'], ['/api/avatar', Buffer.alloc(2 * 1024 * 1024 + 1), 'image/png'], ['/api/records/' + crypto.randomUUID() + '/photos', Buffer.alloc(2 * 1024 * 1024 + 1), 'image/png']]) {
    const response = await handler(request(path, { method: 'POST', rawBody, headers: { 'Content-Type': type } }));
    assert.equal(response.status, 413); assert.equal(response.headers.get('Access-Control-Allow-Origin'), PAGES);
  }
  assert.equal(calls, 0);
});

test('Edge photo uploads use the image limit and PostgreSQL boolean mapping preserves nested receipt values', async () => {
  let received;
  const handler = createEdgeHandler({ ...migrationConfig, DB: fakeDatabase(), BUCKET: {}, worker: { async fetch(input) { received = await input.arrayBuffer(); return new Response('{}', { headers: { 'Content-Type': 'application/json' } }); } } });
  const response = await handler(request('/api/records/' + crypto.randomUUID() + '/photos', { method: 'POST', rawBody: Buffer.alloc(30000), headers: { 'Content-Type': 'image/png' } }));
  assert.equal(response.status, 200); assert.equal(received.byteLength, 30000);
  const connection = { async unsafe() { return [{ public_shared: true, missing: false, metadata: { credentialsPreserved: true } }]; }, async begin(options, callback) { return callback(this); } };
  assert.deepEqual(await createPostgresDatabase(connection).prepare('SELECT predicate').first(), { public_shared: 1, missing: 0, metadata: { credentialsPreserved: true } });
});

test('Edge APIs fail closed when migration configuration or a matching receipt is absent', async () => {
  let workerCalls = 0;
  for (const options of [
    { publicOrigin: ORIGIN, DB: fakeDatabase() },
    { ...migrationConfig, DB: fakeDatabase(null) },
    { ...migrationConfig, DB: fakeDatabase(migrationReceipt({ migrationId: 'c'.repeat(64) })) }
  ]) {
    const handler = createEdgeHandler({ ...options, BUCKET: {}, worker: { async fetch() { workerCalls++; throw new Error('Must not initialize a blank application.'); } } });
    assert.deepEqual(await (await handler(request('/healthz'))).json(), { ok: true, maintenance: true });
    for (const [path, method] of [['/api/auth/me', 'GET'], ['/api/board', 'GET'], ['/api/migration', 'GET'], ['/api/clubs', 'POST'], ['/api/auth/register', 'POST']]) {
      const response = await handler(request(path, { method, ...(method === 'POST' ? { body: {} } : {}) }));
      assert.equal(response.status, 503); assert.equal(response.headers.get('Set-Cookie'), null);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), PAGES);
    }
  }
  assert.equal(workerCalls, 0);
});

const LIVE_URL = process.env.TENNIS_TEST_POSTGRES_URL;
const LIVE_DRIVER = process.env.TENNIS_TEST_POSTGRES_DRIVER;
const skipLive = !LIVE_URL;

async function liveFixture(t) {
  const url = new URL(LIVE_URL);
  const allowedFixture = url.port === '32768' && url.pathname === '/tennisqa' || url.port === '54329' && url.pathname === '/postgres';
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !allowedFixture) throw new Error('Live tests require an explicitly configured synthetic local Postgres fixture.');
  const { default: postgres } = LIVE_DRIVER ? await import(pathToFileURL(LIVE_DRIVER)) : await import('postgres');
  const admin = postgres(LIVE_URL, { ...postgresOptions(), ssl: false });
  const databaseName = 'tennis_backend_test_' + crypto.randomUUID().replaceAll('-', '');
  const connections = [];
  let created = false;
  t.after(async () => {
    await Promise.all(connections.map(connection => connection.end({ timeout: 1 })));
    if (created) await admin.unsafe('DROP DATABASE "' + databaseName + '" WITH (FORCE)');
    await admin.end({ timeout: 1 });
  });
  await admin.unsafe('CREATE DATABASE "' + databaseName + '"'); created = true;
  url.pathname = '/' + databaseName;
  const openConnection = () => { const connection = postgres(url.href, { ...postgresOptions(), ssl: false }); connections.push(connection); return connection; };
  const connection = openConnection();
  for (const migration of ['20261004000000_tennis_schema.sql', '20261004000001_tennis_schema5.sql']) await connection.unsafe(await readFile(new URL('../supabase/migrations/' + migration, import.meta.url), 'utf8'));
  return { DB: createPostgresDatabase(connection), connection, openConnection };
}

function sharedApi(DB, BUCKET) {
  const call = async (path, { method = 'GET', token, invite, body, rawBody, headers: extraHeaders = {} } = {}) => {
    const headers = { Origin: PAGES, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
    if (token) headers['X-Tennis-Session'] = token;
    if (invite) headers.Authorization = 'Bearer ' + invite;
    const response = await worker.fetch(new Request(ORIGIN + path, { method, headers: { ...headers, ...extraHeaders }, body: body === undefined ? rawBody : JSON.stringify(body) }), { DB, BUCKET });
    if (response.headers.get('Content-Type')?.startsWith('image/')) return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
  call.DB = DB;
  return call;
}

test('live Postgres executes shared identity, profile, six-axis training, calendar, culture, and growth SQL', { skip: skipLive }, async t => {
  const { DB } = await liveFixture(t), call = sharedApi(DB);
  const legacy = await newLiveClub(call), { invite, token: legacyToken } = legacy;
  let board = await call('/api/board', { invite, token: legacyToken });
  assert.equal(board.status, 200, JSON.stringify(board.data));
  const clubId = board.data.club.id, memberId = board.data.me, registrationNonce = nonce();
  const enabled = await call('/api/auth/register', { method: 'POST', invite, token: legacyToken, body: { registrationNonce } });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  const resumed = await call('/api/auth/register', { method: 'POST', invite, token: legacyToken, body: { registrationNonce } });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
  assert.equal(resumed.data.recoveryCode, enabled.data.recoveryCode);
  const loggedIn = await call('/api/auth/login', { method: 'POST', body: { recoveryCode: enabled.data.recoveryCode } });
  assert.equal(loggedIn.status, 200, JSON.stringify(loggedIn.data));
  const token = loggedIn.data.sessionToken;
  assert.equal((await call('/api/auth/me', { token })).data.clubs[0].isOwner, true);
  assert.equal((await call(`/api/profile?club=${clubId}`, { method: 'POST', token, body: { nickname: 'Chris继续成长', bio: '每周挥拍' } })).status, 200);
  assert.equal((await call(`/api/club?club=${clubId}`, { method: 'PATCH', token, body: { name: '长期成长群', slogan: '一起挥拍' } })).status, 200);
  const recordId = crypto.randomUUID();
  const record = { id: recordId, playDate: '2026-01-20', minutes: 75, mood: '认真练球', skills: { forehand: 6, backhand: 5, serve: 7, return_skill: 6, net: 4, footwork: 8 }, training: { projects: ['serve', 'footwork'], content: '二发与回位', effect: 'some', effectNote: '更稳定', nextPlan: '落点控制' } };
  assert.equal((await call(`/api/records?club=${clubId}`, { method: 'POST', token, body: record })).status, 201);
  assert.equal((await call(`/api/checkins?club=${clubId}`, { method: 'POST', token, body: {} })).status, 200);
  assert.equal((await call(`/api/cheers?club=${clubId}`, { method: 'POST', token, body: { recordId, emoji: '🎾' } })).status, 200);
  const cultureId = crypto.randomUUID();
  assert.equal((await call(`/api/culture?club=${clubId}`, { method: 'POST', token, body: { id: cultureId, content: '今天也是成长的一天' } })).status, 201);
  board = await call(`/api/board?club=${clubId}`, { token });
  assert.equal(board.status, 200, JSON.stringify(board.data));
  assert.equal(board.data.me, memberId); assert.equal(board.data.club.ownerId, memberId);
  assert.equal(board.data.members[0].avg_serve, 7); assert.equal(board.data.totals.minutes, 75);
  const growth = await call(`/api/growth?club=${clubId}&month=2026-01`, { token });
  assert.equal(growth.status, 200, JSON.stringify(growth.data));
  assert.equal(growth.data.summary.training_sessions, 1); assert.equal(growth.data.history[0].total, 36);
  assert.equal(growth.data.trainingDays[0].minutes, 75); assert.equal(growth.data.nextPlan.next_plan, '落点控制');
  assert.equal((await call(`/api/records/${recordId}?club=${clubId}`, { method: 'PATCH', token, body: { ...record, minutes: 90 } })).status, 200);
  assert.equal((await call(`/api/invite?club=${clubId}`, { method: 'POST', token, body: {} })).status, 200);
  const rotated = await call('/api/auth/recovery', { method: 'POST', token, body: {} });
  assert.equal(rotated.status, 200); assert.equal((await call('/api/auth/login', { method: 'POST', body: { recoveryCode: enabled.data.recoveryCode } })).status, 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { recoveryCode: rotated.data.recoveryCode } })).status, 200);
  assert.equal((await call(`/api/culture/${cultureId}?club=${clubId}`, { method: 'DELETE', token })).status, 200);
  assert.equal((await call(`/api/records/${recordId}?club=${clubId}`, { method: 'DELETE', token })).status, 200);
  assert.equal((await call('/api/auth/logout', { method: 'POST', token, body: {} })).status, 200);
});

test('live Postgres batches roll back preceding writes on uniqueness failure', { skip: skipLive }, async t => {
  const { DB } = await liveFixture(t);
  const account = [crypto.randomUUID(), 'original owner', nonce(), new Date().toISOString()];
  const insert = 'INSERT INTO accounts(id,display_name,recovery_hash,created_at) VALUES(?,?,?,?)';
  await DB.prepare(insert).bind(...account).run();
  const second = [crypto.randomUUID(), 'must roll back', nonce(), new Date().toISOString()];
  await assert.rejects(() => DB.batch([DB.prepare(insert).bind(...second), DB.prepare(insert).bind(...account)]), /UNIQUE constraint/);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM accounts').first()).n, 1);
  assert.equal((await DB.prepare('SELECT id FROM accounts WHERE id=?').bind(account[0]).first()).id, account[0]);
  assert.equal(await DB.prepare('SELECT id FROM accounts WHERE id=?').bind(second[0]).first(), null);
});

async function newLiveClub(call, token) {
  // Schema four already allowed anonymous member creation. Seed that history
  // directly; schema five requires signup for every new group/member.
  const legacyToken = token || nonce(), invite = nonce(), clubId = crypto.randomUUID(), memberId = crypto.randomUUID(), createdAt = '2026-01-01T00:00:00.000Z';
  await call.DB.batch([
    call.DB.prepare('INSERT INTO clubs(id,invite_hash,name,slogan,owner_id,created_at) VALUES(?,?,?,?,?,?)').bind(clubId, await hash(invite), '保留原来的成长群', '原来的群文化', memberId, createdAt),
    call.DB.prepare('INSERT INTO members(id,club_id,session_hash,nickname,bio,created_at) VALUES(?,?,?,?,?,?)').bind(memberId, clubId, await hash(legacyToken), 'Chris', '历史名片', createdAt)
  ]);
  const board = await call('/api/board', { invite, token: legacyToken });
  assert.equal(board.status, 200, JSON.stringify(board.data));
  return { token: legacyToken, invite, clubId: board.data.club.id, memberId: board.data.me, registrationNonce: nonce() };
}

test('live Postgres concurrent registrations from separate connections preserve one account and roll back the loser', { skip: skipLive, timeout: 15000 }, async t => {
  const { DB, connection, openConnection } = await liveFixture(t), call = sharedApi(DB);
  const club = await newLiveClub(call);
  const otherConnection = openConnection();
  let arrivals = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const timer = setTimeout(release, 5000);
  t.after(() => clearTimeout(timer));
  const concurrentDatabase = client => createPostgresDatabase({
    unsafe: client.unsafe.bind(client),
    begin: (options, callback) => client.begin(options, transaction => callback({
      async unsafe(sql, values) {
        const result = await transaction.unsafe(sql, values);
        if (sql.startsWith('INSERT INTO accounts')) {
          if (++arrivals === 2) release();
          await barrier;
        }
        return result;
      }
    }))
  });
  const bodies = [{ registrationNonce: nonce() }, { registrationNonce: nonce() }];
  const results = await Promise.all([connection, otherConnection].map((client, index) => sharedApi(concurrentDatabase(client))('/api/auth/register', { method: 'POST', invite: club.invite, token: club.token, body: bodies[index] })));
  assert.equal(arrivals, 2, 'Both transactions must read the original unbound member before either updates it.');
  const winner = results.find(result => result.status === 200), loser = results.find(result => result.status !== 200);
  assert.ok(winner, JSON.stringify(results.map(result => result.data)));
  assert.ok(loser, 'Exactly one registration may succeed.');
  assert.ok([401, 409, 503].includes(loser.status));
  assert.equal(loser.headers.get('Set-Cookie'), null);
  for (const field of ['recoveryCode', 'sessionToken', 'account']) assert.equal(loser.data[field], undefined);
  for (const table of ['accounts', 'account_sessions', 'auth_registrations']) assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n, 1, table + ' must not retain the losing registration.');
  const saved = await DB.prepare('SELECT id,account_id FROM members WHERE club_id=?').bind(club.clubId).first();
  assert.deepEqual(saved, { id: club.memberId, account_id: winner.data.account.id });
  assert.equal((await DB.prepare('SELECT owner_id FROM clubs WHERE id=?').bind(club.clubId).first()).owner_id, club.memberId);
  assert.equal((await call(`/api/board?club=${club.clubId}`, { token: winner.data.sessionToken })).data.me, club.memberId);
});

test('live Postgres binds preserved cross-group member IDs and history while refusing another member in the same group', { skip: skipLive }, async t => {
  const { DB } = await liveFixture(t), call = sharedApi(DB);
  const first = await newLiveClub(call), second = await newLiveClub(call, first.token);
  const recordId = crypto.randomUUID();
  assert.equal((await call('/api/records', { method: 'POST', invite: second.invite, token: second.token, body: { id: recordId, playDate: '2026-01-20', minutes: 60, mood: '认真练球', note: '原成员的长期记录' } })).status, 201);
  const enabled = await call('/api/auth/register', { method: 'POST', invite: first.invite, token: first.token, body: { registrationNonce: first.registrationNonce } });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.legacySessionToken, second.token);
  assert.deepEqual(enabled.data.legacyClubs.map(club => club.id), [second.clubId]);
  const token = enabled.data.sessionToken;
  assert.equal((await call(`/api/auth/bind?club=${second.clubId}`, { method: 'POST', token, body: { legacySessionToken: nonce() } })).status, 401);
  const bound = await call(`/api/auth/bind?club=${second.clubId}`, { method: 'POST', token, body: { legacySessionToken: second.token } });
  assert.equal(bound.status, 200, JSON.stringify(bound.data));
  assert.equal(bound.data.id, second.memberId);
  const board = await call(`/api/board?club=${second.clubId}`, { token });
  assert.equal(board.data.me, second.memberId); assert.equal(board.data.club.ownerId, second.memberId);
  assert.equal(board.data.records[0].member_id, second.memberId); assert.equal(board.data.records[0].id, recordId);
  assert.equal((await call('/api/auth/me', { token })).data.clubs.length, 2);
  assert.equal((await call('/api/board', { invite: second.invite, token: second.token })).status, 401);
  assert.equal((await call(`/api/auth/bind?club=${second.clubId}`, { method: 'POST', token, body: { legacySessionToken: second.token } })).status, 401);
  const otherToken = nonce(), otherMemberId = crypto.randomUUID();
  await DB.prepare('INSERT INTO members(id,club_id,session_hash,nickname,bio,created_at) VALUES(?,?,?,?,?,?)').bind(otherMemberId, first.clubId, await hash(otherToken), 'Chris', '同名的历史球友', '2026-01-01T00:00:00.000Z').run();
  assert.notEqual(otherMemberId, first.memberId);
  assert.equal((await call(`/api/auth/bind?club=${first.clubId}`, { method: 'POST', token, body: { legacySessionToken: otherToken } })).status, 409);
  assert.equal((await DB.prepare('SELECT account_id FROM members WHERE id=?').bind(otherMemberId).first()).account_id, null);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM accounts').first()).n, 1);
});

async function writeMigrationReceipt(DB, overrides = {}) {
  const tableCounts = {};
  for (const table of DATA_TABLES) tableCounts[table] = (await DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
  const receipt = migrationReceipt({ tableCounts, ...overrides });
  await DB.prepare("INSERT INTO tennis_migration_receipt(id,metadata) VALUES('current',CAST(? AS TEXT)::jsonb) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata").bind(JSON.stringify(receipt)).run();
  return receipt;
}

async function databaseSnapshot(DB) {
  const snapshot = {};
  for (const table of DATA_TABLES) snapshot[table] = (await DB.prepare(`SELECT * FROM ${table}`).all()).results.map(row => JSON.stringify(row)).sort();
  return JSON.stringify(snapshot);
}

test('live Postgres migration receipt gates all ordinary APIs and protects application tables from browser roles', { skip: skipLive }, async t => {
  const { DB } = await liveFixture(t);
  let workerCalls = 0;
  const handler = createEdgeHandler({ ...migrationConfig, DB, BUCKET: {}, worker: { async fetch() { workerCalls++; return new Response('{}', { headers: { 'Content-Type': 'application/json' } }); } } });
  for (const state of ['missing', 'wrong-id', 'incomplete-counts', 'ready']) {
    if (state !== 'missing') await writeMigrationReceipt(DB, state === 'wrong-id' ? { migrationId: 'c'.repeat(64) } : state === 'incomplete-counts' ? { tableCounts: { accounts: 0 } } : {});
    const ready = state === 'ready';
    const health = await handler(request('/healthz'));
    assert.equal(health.status, 200); assert.deepEqual(await health.json(), { ok: true, maintenance: !ready });
    for (const path of ['/api/auth/me', '/api/board', '/api/migration']) {
      const response = await handler(request(path));
      assert.equal(response.status, ready ? 200 : 503, state + ':' + path);
      assert.equal(response.headers.get('Set-Cookie'), null);
      if (!ready) assert.equal(response.headers.get('Access-Control-Allow-Origin'), PAGES);
    }
    const signup = await handler(request('/api/clubs', { method: 'POST', body: { name: '不丢记录', nickname: 'Chris' } }));
    assert.equal(signup.status, ready ? 200 : 503);
    if (!ready) assert.equal(workerCalls, 0, 'A missing receipt must never reach an empty database signup.');
  }
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM clubs').first()).n, 0);
  const rows = (await DB.prepare("SELECT c.relname,c.relrowsecurity,has_table_privilege('anon',c.oid,'SELECT') AS anon_select,has_table_privilege('authenticated',c.oid,'INSERT') AS browser_insert FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'").all()).results;
  assert.equal(rows.length, DATA_TABLES.length + 1);
  for (const row of rows) { assert.equal(row.relrowsecurity, 1, row.relname); assert.equal(row.anon_select, 0, row.relname); assert.equal(row.browser_insert, 0, row.relname); }
});

test('live Postgres migration validation recognizes preserved proofs, rejects rotated and expired secrets, and writes nothing', { skip: skipLive }, async t => {
  const { DB } = await liveFixture(t), call = sharedApi(DB);
  const bound = await newLiveClub(call);
  const registered = await call('/api/auth/register', { method: 'POST', invite: bound.invite, token: bound.token, body: { registrationNonce: bound.registrationNonce } });
  assert.equal(registered.status, 200);
  const account = registered.data, unbound = await newLiveClub(call);
  const alternate = await call('/api/invite', { method: 'POST', invite: unbound.invite, token: unbound.token, body: {} });
  assert.equal(alternate.status, 200);
  const recordId = crypto.randomUUID();
  assert.equal((await call('/api/records', { method: 'POST', invite: bound.invite, token: account.sessionToken, body: { id: recordId, playDate: '2026-01-20', minutes: 60, mood: '认真练球' } })).status, 201);
  assert.equal((await call('/api/checkins', { method: 'POST', invite: bound.invite, token: account.sessionToken, body: {} })).status, 200);
  assert.equal((await call('/api/cheers', { method: 'POST', invite: bound.invite, token: account.sessionToken, body: { recordId, emoji: '🎾' } })).status, 200);
  assert.equal((await call('/api/culture', { method: 'POST', invite: bound.invite, token: account.sessionToken, body: { id: crypto.randomUUID(), content: '原来的群文化' } })).status, 201);
  await writeMigrationReceipt(DB);
  const handler = createEdgeHandler({ ...migrationConfig, DB, BUCKET: {}, worker });
  const proofs = [
    { proofId: 'account', kind: 'account', token: account.sessionToken },
    { proofId: 'member', kind: 'member', token: unbound.token, invite: unbound.invite },
    { proofId: 'member-no-invite', kind: 'member', token: unbound.token },
    { proofId: 'member-extra-invite', kind: 'member', token: unbound.token, invite: alternate.data.invite },
    { proofId: 'claim', kind: 'claim', token: unbound.token, clubId: unbound.clubId },
    { proofId: 'registration-unbound', kind: 'registration', token: unbound.token, clubId: unbound.clubId, registrationNonce: unbound.registrationNonce },
    { proofId: 'registration-bound', kind: 'registration', token: bound.token, clubId: bound.clubId, registrationNonce: bound.registrationNonce },
    { proofId: 'wrong-token', kind: 'account', token: nonce() },
    { proofId: 'wrong-invite', kind: 'member', token: unbound.token, invite: bound.invite },
    { proofId: 'wrong-club', kind: 'claim', token: unbound.token, clubId: bound.clubId },
    { proofId: 'bound-member', kind: 'member', token: bound.token },
    { proofId: 'bound-claim', kind: 'claim', token: bound.token, clubId: bound.clubId },
    { proofId: 'wrong-nonce', kind: 'registration', token: bound.token, clubId: bound.clubId, registrationNonce: nonce() },
    { proofId: 'invalid-array', kind: 'account', token: [account.sessionToken] },
    { proofId: 'invalid-token', kind: 'account', token: 'invalid' }
  ];
  const validate = async (input = proofs) => {
    const before = await databaseSnapshot(DB);
    const response = await handler(request('/api/migration/validate', { method: 'POST', body: { migrationId: MIGRATION_ID, proofs: input } }));
    assert.equal(response.status, 200); assert.equal(response.headers.get('Set-Cookie'), null);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), PAGES);
    const body = await response.json(), serialized = JSON.stringify(body);
    for (const secret of [bound.token, bound.invite, unbound.token, unbound.invite, account.sessionToken, account.recoveryCode, bound.registrationNonce]) assert.equal(serialized.includes(secret), false);
    assert.equal(await databaseSnapshot(DB), before, 'Validation must preserve every row of all fifteen application tables.');
    return body.acceptedProofIds;
  };
  assert.deepEqual(await validate(), ['account', 'member', 'member-no-invite', 'member-extra-invite', 'claim', 'registration-unbound', 'registration-bound']);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM auth_failures').first()).n, 0);
  await DB.prepare('UPDATE auth_registrations SET expires_at=?').bind(Date.now() - 1000).run();
  assert.deepEqual(await validate(proofs.filter(proof => ['account', 'registration-bound'].includes(proof.proofId))), ['account']);
  await DB.prepare('UPDATE auth_registrations SET expires_at=?').bind(Date.now() + 60000).run();
  assert.equal((await call('/api/auth/recovery', { method: 'POST', token: account.sessionToken, body: {} })).status, 200);
  assert.deepEqual(await validate(proofs.filter(proof => ['account', 'registration-bound'].includes(proof.proofId))), ['account']);
  await DB.prepare('UPDATE account_sessions SET expires_at=?').bind(Date.now() - 1000).run();
  assert.deepEqual(await validate(proofs.filter(proof => ['account', 'registration-bound'].includes(proof.proofId))), []);
  const proof = proofs[0];
  for (const body of [
    { migrationId: 'c'.repeat(64), proofs: [proof] },
    { migrationId: MIGRATION_ID, proofs: [{ ...proof, proofId: 'x'.repeat(81) }] },
    { migrationId: MIGRATION_ID, proofs: [{ ...proof, proofId: 'invalid.id' }] },
    { migrationId: MIGRATION_ID, proofs: [proof, proof] },
    { migrationId: MIGRATION_ID, proofs: Array.from({ length: 101 }, (_, index) => ({ ...proof, proofId: 'proof-' + index })) }
  ]) assert.equal((await handler(request('/api/migration/validate', { method: 'POST', body }))).status, 400);
  assert.equal((await handler(request('/api/migration/validate', { method: 'POST', body: { migrationId: MIGRATION_ID, proofs: [proof], padding: 'x'.repeat(21000) } }))).status, 413);
});

function privateMemoryBucket() {
  const objects = new Map(), deleted = [];
  return {
    objects, deleted,
    async put(key, bytes, options) { objects.set(key, { bytes: Buffer.from(bytes), contentType: options.httpMetadata.contentType }); },
    async get(key) {
      const object = objects.get(key); if (!object) return null;
      return { body: new Response(object.bytes).body, httpMetadata: { contentType: object.contentType }, async arrayBuffer() { return Uint8Array.from(object.bytes).buffer; } };
    },
    async delete(key) { deleted.push(key); objects.delete(key); }
  };
}

async function signup(call, email = 'chris-' + crypto.randomUUID() + '@example.test', password = 'a-test-password-123') {
  const response = await call('/api/auth/signup', { method: 'POST', body: { email, password, nickname: 'Chris' } });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return { ...response.data, email: email.trim().toLowerCase(), password };
}

async function accountClub(call, account) {
  const created = await call('/api/clubs', { method: 'POST', token: account.sessionToken, body: { name: '新的成长群', nickname: 'Chris', slogan: '以球会友' } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const board = await call('/api/board', { invite: created.data.invite, token: account.sessionToken });
  assert.equal(board.status, 200);
  return { invite: created.data.invite, clubId: board.data.club.id, memberId: board.data.me };
}

test('live Postgres signup and email credentials preserve legacy history, normalize identity, and roll back duplicate email signup', { skip: skipLive }, async t => {
  const { DB } = await liveFixture(t), call = sharedApi(DB), legacy = await newLiveClub(call);
  assert.equal((await call('/api/clubs', { method: 'POST', body: { name: '不能匿名新建', nickname: 'Chris' } })).status, 401);
  assert.equal((await call('/api/profile', { method: 'POST', invite: legacy.invite, body: { nickname: '不能匿名加入' } })).status, 401);
  const legacySignup = await call('/api/auth/signup', { method: 'POST', token: legacy.token, body: { email: 'legacy@example.test', password: 'test-password-legacy', nickname: '新身份' } });
  assert.equal(legacySignup.status, 409);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM accounts').first()).n, 0);
  const original = await call('/api/auth/register', { method: 'POST', invite: legacy.invite, token: legacy.token, body: { registrationNonce: legacy.registrationNonce } });
  assert.equal(original.status, 200);
  const token = original.data.sessionToken;
  assert.equal((await call('/api/auth/credentials', { method: 'POST', token, body: { email: '  Legacy@Example.Test ', password: 'test-password-legacy' } })).status, 200);
  const credential = await DB.prepare('SELECT * FROM account_credentials WHERE account_id=?').bind(original.data.account.id).first();
  assert.equal(credential.email, 'legacy@example.test'); assert.match(credential.password_hash, /^[a-f0-9]{64}$/); assert.match(credential.password_salt, /^[a-f0-9]{32}$/);
  assert.notEqual(credential.password_hash, 'test-password-legacy');
  const loggedIn = await call('/api/auth/login', { method: 'POST', body: { email: 'LEGACY@example.test', password: 'test-password-legacy' } });
  assert.equal(loggedIn.status, 200); assert.equal(loggedIn.data.account.id, original.data.account.id);
  const board = await call(`/api/board?club=${legacy.clubId}`, { token: loggedIn.data.sessionToken });
  assert.equal(board.data.me, legacy.memberId); assert.equal(board.data.club.ownerId, legacy.memberId);
  assert.equal((await call('/api/auth/me', { token })).data.account.hasEmail, true);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { recoveryCode: original.data.recoveryCode } })).data.account.id, original.data.account.id);
  const knownWrong = await call('/api/auth/login', { method: 'POST', body: { email: credential.email, password: 'wrong-password-123' } });
  const unknown = await call('/api/auth/login', { method: 'POST', body: { email: 'missing@example.test', password: 'wrong-password-123' } });
  assert.equal(knownWrong.status, 401); assert.equal(unknown.status, 401); assert.deepEqual(knownWrong.data, unknown.data);
  const accountsBefore = (await DB.prepare('SELECT COUNT(*) AS n FROM accounts').first()).n, sessionsBefore = (await DB.prepare('SELECT COUNT(*) AS n FROM account_sessions').first()).n;
  const duplicate = await call('/api/auth/signup', { method: 'POST', body: { email: 'Legacy@Example.Test', password: 'another-password-123', nickname: '另一个Chris' } });
  assert.equal(duplicate.status, 409);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM accounts').first()).n, accountsBefore);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM account_sessions').first()).n, sessionsBefore);
  const newAccount = await signup(call), newClub = await accountClub(call, newAccount);
  assert.notEqual(newClub.memberId, legacy.memberId);
  assert.equal((await call('/api/auth/credentials', { method: 'POST', token: newAccount.sessionToken, body: { email: credential.email, password: 'another-password-123' } })).status, 409);
  assert.equal((await DB.prepare('SELECT account_id FROM account_credentials WHERE email=?').bind(credential.email).first()).account_id, original.data.account.id);
});

test('live Postgres monthly zero/null scores, private photos, explicit public cards, and administrative revocation preserve source semantics', { skip: skipLive }, async t => {
  const { DB } = await liveFixture(t), BUCKET = privateMemoryBucket(), call = sharedApi(DB, BUCKET), owner = await signup(call), club = await accountClub(call, owner);
  const token = owner.sessionToken, query = '?club=' + club.clubId;
  assert.equal((await call('/api/board', { invite: club.invite })).status, 401);
  const invitation = await call('/api/invitation', { invite: club.invite });
  assert.equal(invitation.status, 200); assert.deepEqual(Object.keys(invitation.data).sort(), ['club', 'joined', 'legacy']);
  const scores = { forehand: 0, backhand: null, serve: 5, return_skill: null, net: 0, footwork: 6 };
  assert.equal((await call('/api/ratings' + query, { method: 'POST', token, body: { month: '2026-01', skills: scores } })).status, 200);
  const rating = (await call('/api/ratings' + query, { token })).data.ratings[0];
  for (const [key, value] of Object.entries(scores)) assert.equal(rating[key], value, 'Schema must preserve zero versus untested.');
  const recordId = crypto.randomUUID();
  assert.equal((await call('/api/records' + query, { method: 'POST', token, body: { id: recordId, playDate: '2026-01-20', minutes: 60, mood: '认真练球', skills: scores, note: '仅群友可见的训练感想' } })).status, 201);
  const upload = await call('/api/records/' + recordId + '/photos' + query, { method: 'POST', token, rawBody: PNG, headers: { 'Content-Type': 'image/png' } });
  assert.equal(upload.status, 201, JSON.stringify(upload.data));
  const photo = await DB.prepare('SELECT * FROM record_photos WHERE id=?').bind(upload.data.id).first();
  assert.equal(photo.byte_size, PNG.length); assert.equal(photo.content_type, 'image/png'); assert.equal(photo.member_id, club.memberId);
  const downloaded = await call('/api/photos/' + photo.id + query, { token });
  assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.bytes, PNG);
  assert.equal((await call('/api/photos/' + photo.id, { invite: club.invite })).status, 401);
  assert.equal((await call('/api/avatar' + query, { method: 'POST', token, rawBody: PNG, headers: { 'Content-Type': 'image/png' } })).status, 200);
  const share = await call('/api/share' + query, { method: 'POST', token, body: { enabled: true } });
  assert.equal(share.status, 200); assert.match(share.data.token, /^[a-f0-9]{64}$/);
  assert.equal((await DB.prepare('SELECT public_share_hash FROM members WHERE id=?').bind(club.memberId).first()).public_share_hash, await hash(share.data.token));
  const card = await call('/api/public/card/' + share.data.token);
  assert.equal(card.status, 200); assert.deepEqual(Object.keys(card.data).sort(), ['bio', 'hasAvatar', 'nickname', 'rating']);
  assert.equal(card.data.rating.forehand, 0); assert.equal(card.data.rating.backhand, null);
  assert.equal(JSON.stringify(card.data).includes('仅群友可见'), false); assert.equal(JSON.stringify(card.data).includes(owner.email), false);
  assert.deepEqual((await call('/api/public/avatar/' + share.data.token)).bytes, PNG);
  const board = (await call('/api/board' + query, { token })).data;
  assert.equal(board.members[0].public_shared, 1); assert.equal(board.members[0].rating.forehand, 0);
  assert.deepEqual(Object.keys(board.photos[0]).sort(), ['created_at', 'id', 'member_id', 'record_id']);
  assert.equal((await call('/api/share' + query, { method: 'POST', token, body: { enabled: false } })).status, 200);
  assert.equal((await call('/api/public/card/' + share.data.token)).status, 404); assert.equal((await call('/api/public/avatar/' + share.data.token)).status, 404);
  const friend = await signup(call), joined = await call('/api/profile', { method: 'POST', invite: club.invite, token: friend.sessionToken, body: { nickname: 'Chris', bio: '另一位球友' } });
  assert.equal(joined.status, 201); assert.notEqual(joined.data.id, club.memberId);
  assert.equal((await call('/api/admin' + query, { token: friend.sessionToken })).status, 403);
  const friendShare = await call('/api/share' + query, { method: 'POST', token: friend.sessionToken, body: { enabled: true } });
  assert.equal((await call('/api/ratings' + query, { method: 'POST', token, body: { memberId: joined.data.id, month: '2026-01', skills: scores } })).status, 200);
  assert.equal((await call('/api/members/' + joined.data.id + query, { method: 'DELETE', token })).status, 200);
  assert.equal((await call('/api/public/card/' + friendShare.data.token)).status, 404);
  assert.equal((await call('/api/board' + query, { token: friend.sessionToken })).status, 403);
  assert.equal((await call('/api/profile', { method: 'POST', invite: club.invite, token: friend.sessionToken, body: { nickname: '绕过移除' } })).status, 403);
  assert.equal((await call('/api/members/' + joined.data.id + query, { method: 'PATCH', token, body: {} })).status, 200);
  assert.equal((await call('/api/board' + query, { token: friend.sessionToken })).data.me, joined.data.id);
  assert.equal((await call('/api/public/card/' + friendShare.data.token)).status, 404, 'Restoration must not reactivate an old public link.');
  const extraInvite = await call('/api/invite' + query, { method: 'POST', token, body: {} });
  assert.equal(extraInvite.status, 200);
  assert.equal((await call('/api/invitation', { invite: extraInvite.data.invite })).status, 200);
  assert.equal((await call('/api/invites/' + await hash(extraInvite.data.invite) + query, { method: 'DELETE', token })).status, 200);
  assert.equal((await call('/api/invitation', { invite: extraInvite.data.invite })).status, 404);
  assert.equal((await call('/api/invites/original' + query, { method: 'DELETE', token })).status, 200);
  assert.equal((await call('/api/invitation', { invite: club.invite })).status, 404);
  assert.equal((await call('/api/board' + query, { token })).status, 200);
  const audit = (await call('/api/admin' + query, { token })).data.events.map(event => event.action);
  for (const action of ['edit-rating', 'remove-member', 'restore-member', 'create-invite', 'revoke-invite']) assert.ok(audit.includes(action), action);
  assert.equal((await call('/api/records/' + recordId + query, { method: 'DELETE', token })).status, 200);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM record_photos WHERE record_id=?').bind(recordId).first()).n, 0);
  assert.equal(BUCKET.objects.has(photo.object_key), false, 'Deleting a record removes its private photo object.');
});

test('live Postgres concurrent photo writes from two instances cap a record at three and clean the losing private object', { skip: skipLive, timeout: 15000 }, async t => {
  const { DB, connection, openConnection } = await liveFixture(t), BUCKET = privateMemoryBucket(), call = sharedApi(DB, BUCKET), account = await signup(call), club = await accountClub(call, account);
  const recordId = crypto.randomUUID(), token = account.sessionToken, query = '?club=' + club.clubId;
  assert.equal((await call('/api/records' + query, { method: 'POST', token, body: { id: recordId, playDate: '2026-01-20', minutes: 60, mood: '认真练球' } })).status, 201);
  const uploadPath = '/api/records/' + recordId + '/photos' + query;
  for (let index = 0; index < 2; index++) assert.equal((await call(uploadPath, { method: 'POST', token, rawBody: PNG, headers: { 'Content-Type': 'image/png' } })).status, 201);
  let arrivals = 0, release;
  const barrier = new Promise(resolve => { release = resolve; }), timer = setTimeout(release, 5000);
  t.after(() => clearTimeout(timer));
  const withBarrier = client => createPostgresDatabase({
    unsafe: client.unsafe.bind(client), begin: (options, callback) => client.begin(options, transaction => callback({
      async unsafe(sql, values) {
        const result = await transaction.unsafe(sql, values);
        if (sql.startsWith('INSERT INTO record_photos')) { if (++arrivals === 2) release(); await barrier; }
        return result;
      }
    }))
  });
  const results = await Promise.all([connection, openConnection()].map(client => sharedApi(withBarrier(client), BUCKET)(uploadPath, { method: 'POST', token, rawBody: PNG, headers: { 'Content-Type': 'image/png' } })));
  assert.equal(arrivals, 2, 'Both inserts must observe the two-photo state before either commits.');
  assert.equal(results.filter(result => result.status === 201).length, 1);
  const loser = results.find(result => result.status !== 201);
  assert.ok([409, 503].includes(loser.status)); assert.equal(loser.data.id, undefined); assert.equal(loser.headers.get('Set-Cookie'), null);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM record_photos WHERE record_id=?').bind(recordId).first()).n, 3);
  assert.equal(BUCKET.objects.size, 3); assert.equal(BUCKET.deleted.length, 1);
  assert.equal(BUCKET.objects.has(BUCKET.deleted[0]), false);
});
