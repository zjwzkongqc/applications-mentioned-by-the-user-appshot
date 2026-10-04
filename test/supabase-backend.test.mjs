import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
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
const DATA_TABLES = ['accounts', 'account_sessions', 'auth_failures', 'auth_registrations', 'clubs', 'club_invites', 'members', 'records', 'checkins', 'cheers', 'culture'];
const MIGRATION_ID = 'a'.repeat(64), FROM_ORIGIN = 'https://original-tennis.example';
const migrationConfig = { publicOrigin: ORIGIN, migrationId: MIGRATION_ID, migrationFromOrigin: FROM_ORIGIN, migrationPageBaseUrl: PAGE_BASE };

function migrationReceipt(overrides = {}) {
  return {
    formatVersion: 1, appId: 'tennis-dazi-club-2026', schemaVersion: 4, migrationId: MIGRATION_ID,
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
    async begin(options, callback) { return callback(this); }
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
  for (const [path, rawBody, type] of [['/api/profile', 'x'.repeat(20001), 'application/json'], ['/api/avatar', Buffer.alloc(2 * 1024 * 1024 + 1), 'image/png']]) {
    const response = await handler(request(path, { method: 'POST', rawBody, headers: { 'Content-Type': type } }));
    assert.equal(response.status, 413); assert.equal(response.headers.get('Access-Control-Allow-Origin'), PAGES);
  }
  assert.equal(calls, 0);
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
const skipLive = !LIVE_URL || !LIVE_DRIVER;

async function liveFixture(t) {
  const url = new URL(LIVE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.port !== '54329' || url.pathname !== '/postgres') throw new Error('Live tests require the dedicated local postgres container on port 54329.');
  const { default: postgres } = await import(pathToFileURL(LIVE_DRIVER));
  const connection = postgres(LIVE_URL, { ...postgresOptions(), ssl: false });
  t.after(async () => { await connection.end({ timeout: 1 }); });
  await connection.unsafe('TRUNCATE TABLE ' + [...DATA_TABLES, 'tennis_migration_receipt'].map(table => 'public.' + table).join(', '));
  return { DB: createPostgresDatabase(connection), connection };
}

function sharedApi(DB) {
  return async (path, { method = 'GET', token, invite, body } = {}) => {
    const headers = { Origin: PAGES, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
    if (token) headers['X-Tennis-Session'] = token;
    if (invite) headers.Authorization = 'Bearer ' + invite;
    const response = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), { DB });
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
}

test('live Postgres executes shared identity, profile, six-axis training, calendar, culture, and growth SQL', { skip: skipLive }, async t => {
  const { DB } = await liveFixture(t), call = sharedApi(DB);
  const created = await call('/api/clubs', { method: 'POST', body: { name: 'Postgres成长群', nickname: 'Chris', slogan: '' } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const { invite, sessionToken: legacyToken } = created.data;
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
  const created = await call('/api/clubs', { method: 'POST', token, body: { name: '保留原来的成长群', nickname: 'Chris' } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const legacyToken = created.data.sessionToken || token, invite = created.data.invite;
  const board = await call('/api/board', { invite, token: legacyToken });
  assert.equal(board.status, 200, JSON.stringify(board.data));
  return { token: legacyToken, invite, clubId: board.data.club.id, memberId: board.data.me, registrationNonce: nonce() };
}

test('live Postgres concurrent registrations from separate connections preserve one account and roll back the loser', { skip: skipLive, timeout: 15000 }, async t => {
  const { DB, connection } = await liveFixture(t), call = sharedApi(DB);
  const club = await newLiveClub(call);
  const { default: postgres } = await import(pathToFileURL(LIVE_DRIVER));
  const otherConnection = postgres(LIVE_URL, { ...postgresOptions(), ssl: false });
  t.after(async () => { await otherConnection.end({ timeout: 1 }); });
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
  assert.equal((await call('/api/board', { invite: second.invite, token: second.token })).data.me, null);
  assert.equal((await call(`/api/auth/bind?club=${second.clubId}`, { method: 'POST', token, body: { legacySessionToken: second.token } })).status, 401);
  const otherToken = nonce();
  const otherMember = await call('/api/profile', { method: 'POST', invite: first.invite, token: otherToken, body: { nickname: 'Chris', bio: '同名的另一位球友' } });
  assert.equal(otherMember.status, 201, JSON.stringify(otherMember.data));
  assert.notEqual(otherMember.data.id, first.memberId);
  assert.equal((await call(`/api/auth/bind?club=${first.clubId}`, { method: 'POST', token, body: { legacySessionToken: otherToken } })).status, 409);
  assert.equal((await DB.prepare('SELECT account_id FROM members WHERE id=?').bind(otherMember.data.id).first()).account_id, null);
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
  for (const row of rows) { assert.equal(row.relrowsecurity, true, row.relname); assert.equal(row.anon_select, false, row.relname); assert.equal(row.browser_insert, false, row.relname); }
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
    assert.equal(await databaseSnapshot(DB), before, 'Validation must preserve every row of all eleven application tables.');
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
