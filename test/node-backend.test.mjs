import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createDatabase, createBucket } from '../server/storage.mjs';
import { createAppServer } from '../server/http.mjs';
import { createMigrationService } from '../server/migration.mjs';
import { startBackend } from '../server/main.mjs';
import { TABLE_NAMES } from '../scripts/backup-format.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS = join(ROOT, 'drizzle');
const PUBLIC_ORIGIN = 'https://tennis-api.test';
const PAGES = 'https://zjwzkongqc.github.io';
const MIGRATION_ID = 'a'.repeat(64);
const FROM_ORIGIN = 'https://tennis-source.test';
const PAGE_BASE = PAGES + '/applications-mentioned-by-the-user-appshot/';
const DATA_TABLES = TABLE_NAMES;
const fixtureDatabases = new Map();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const nonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
let compiledWorker;

before(async () => {
  execFileSync(process.execPath, ['scripts/build-node.mjs'], { cwd: ROOT, stdio: 'pipe' });
  compiledWorker = (await import(pathToFileURL(join(ROOT, 'dist/node/worker.mjs')))).default;
});

async function httpFixture(t, trustedProxyHops = 0, prepareMigration) {
  const directory = mkdtempSync(join(tmpdir(), 'tennis-node-http-'));
  const DB = createDatabase({ filename: join(directory, 'tennis.sqlite'), migrationsDir: MIGRATIONS });
  const BUCKET = await createBucket({ directory: join(directory, 'objects') });
  const env = { DB, BUCKET };
  const migration = prepareMigration ? await prepareMigration({ directory, DB, env }) : undefined;
  const server = createAppServer({ worker: compiledWorker, env, publicOrigin: PUBLIC_ORIGIN, trustedProxyHops, migration });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  fixtureDatabases.set(url, DB);
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    DB.close();
    fixtureDatabases.delete(url);
    rmSync(directory, { recursive: true, force: true });
  });
  return { url, DB, directory };
}

function api(url, fetchRequest = fetch, database) {
  const call = (path, { method = 'GET', invite, token, origin = PAGES, body, rawBody, headers: extras = {}, duplex } = {}) => {
    const headers = { Origin: origin, ...extras };
    if (invite) headers.Authorization = `Bearer ${invite}`;
    if (token) headers['X-Tennis-Session'] = token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetchRequest(url + path, { method, headers, body: body === undefined ? rawBody : JSON.stringify(body), ...(duplex ? { duplex } : {}) });
  };
  call.database = database || fixtureDatabases.get(url);
  return call;
}

async function newClub(call) {
  // These fixtures are pre-upgrade identities. Schema 5 admits new visitors
  // through signup, while migration must still preserve historical members.
  const invite = nonce(), token = nonce(), clubId = crypto.randomUUID(), memberId = crypto.randomUUID(), time = new Date().toISOString();
  const hash = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');
  assert.ok(call.database, 'Historical identity fixture requires its isolated database.');
  await call.database.batch([
    call.database.prepare('INSERT INTO clubs(id,invite_hash,name,slogan,owner_id,created_at) VALUES(?,?,?,?,?,?)').bind(clubId, await hash(invite), '自主部署成长群', '每周一起挥拍', memberId, time),
    call.database.prepare('INSERT INTO members(id,club_id,session_hash,nickname,avatar_key,bio,created_at,account_id) VALUES(?,?,?,?,NULL,?,?,NULL)').bind(memberId, clubId, await hash(token), 'Chris', '', time)
  ]);
  const board = await (await call('/api/board', { invite, token })).json();
  return { invite, token, clubId: board.club.id, memberId: board.me, registrationNonce: nonce() };
}

test('SQLite migrations and D1 statements persist; failed and concurrent batches remain atomic', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tennis-node-db-'));
  const options = { filename: join(directory, 'tennis.sqlite'), migrationsDir: MIGRATIONS };
  let DB = createDatabase(options);
  t.after(() => { DB.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM accounts').bind().first()).n, 0);
  await DB.prepare('CREATE TABLE adapter_audit(id TEXT PRIMARY KEY, value TEXT NOT NULL)').bind().run();
  const inserted = await DB.prepare('INSERT INTO adapter_audit(id,value) VALUES(?,?)').bind('a', 'before').run();
  assert.equal(inserted.meta.changes, 1);
  assert.equal(await DB.prepare('SELECT value FROM adapter_audit WHERE id=?').bind('a').first('value'), 'before');
  await assert.rejects(DB.batch([
    DB.prepare('INSERT INTO adapter_audit(id,value) VALUES(?,?)').bind('b', 'must roll back'),
    DB.prepare('INSERT INTO adapter_audit(id,value) VALUES(?,?)').bind('a', 'duplicate')
  ]));
  assert.equal(await DB.prepare('SELECT * FROM adapter_audit WHERE id=?').bind('b').first(), null);
  const changed = await DB.batch([
    DB.prepare('UPDATE adapter_audit SET value=? WHERE id=?').bind('after', 'a'),
    DB.prepare('INSERT INTO adapter_audit(id,value) VALUES(?,?)').bind('b', 'persisted')
  ]);
  assert.deepEqual(changed.map(result => result.meta.changes), [1, 1]);
  await Promise.all(['c', 'd'].map(id => DB.batch([DB.prepare('INSERT INTO adapter_audit(id,value) VALUES(?,?)').bind(id, 'concurrent')])));
  DB.close();
  DB = createDatabase(options);
  assert.equal(await DB.prepare('SELECT value FROM adapter_audit WHERE id=?').bind('a').first('value'), 'after');
  const all = await DB.prepare('SELECT id FROM adapter_audit ORDER BY id').bind().all();
  assert.deepEqual(all.results.map(row => row.id), ['a', 'b', 'c', 'd']);
});

test('disk avatars persist bytes and metadata, support replacement/deletion, and reject traversal', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tennis-node-bucket-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = { directory: join(directory, 'objects') };
  const key = `avatars/${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}`;
  let bucket = await createBucket(options);
  await bucket.put(key, PNG, { httpMetadata: { contentType: 'image/png' } });
  bucket = await createBucket(options);
  const saved = await bucket.get(key);
  assert.ok(saved.body instanceof ReadableStream);
  assert.equal(saved.httpMetadata.contentType, 'image/png');
  assert.deepEqual(Buffer.from(await new Response(saved.body).arrayBuffer()), PNG);
  const replacement = Uint8Array.from([1, 2, 3, 4]);
  await bucket.put(key, replacement, { httpMetadata: { contentType: 'image/webp' } });
  const replaced = await bucket.get(key);
  assert.equal(replaced.httpMetadata.contentType, 'image/webp');
  assert.deepEqual(new Uint8Array(await new Response(replaced.body).arrayBuffer()), replacement);
  for (const invalid of ['../outside', '/absolute', 'avatars/../../outside', 'avatars\\..\\outside']) {
    await assert.rejects(() => bucket.put(invalid, PNG, { httpMetadata: { contentType: 'image/png' } }));
    await assert.rejects(() => bucket.get(invalid));
    await assert.rejects(() => bucket.delete(invalid));
  }
  assert.equal(existsSync(join(directory, 'outside')), false);
  await bucket.delete(key);
  assert.equal(await bucket.get(key), null);
  await bucket.delete(key);
});

test('HTTP wrapping preserves two cookies, canonical origin, and authenticated avatar streams with CORS', async t => {
  const fixture = await httpFixture(t), call = api(fixture.url), club = await newClub(call);
  const health = await call('/healthz');
  assert.deepEqual(await health.json(), { ok: true, maintenance: false });
  const registered = await call('/api/auth/register', {
    method: 'POST', invite: club.invite, origin: PUBLIC_ORIGIN,
    headers: { Cookie: `tc_session=${club.token}` }, body: { registrationNonce: club.registrationNonce }
  });
  assert.equal(registered.status, 200);
  const cookies = registered.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.some(cookie => /^tc_session=/.test(cookie) && cookie.includes('HttpOnly') && cookie.includes('Secure')));
  assert.ok(cookies.some(cookie => /^tc_registration_legacy=/.test(cookie) && cookie.includes('Path=/api/auth/register') && cookie.includes('Max-Age=3600')));
  const accountToken = cookies.find(cookie => /^tc_session=/.test(cookie)).match(/^tc_session=([a-f0-9]{64})/)[1];
  const uploaded = await call('/api/avatar', { method: 'POST', invite: club.invite, token: accountToken, rawBody: PNG, headers: { 'Content-Type': 'image/png' } });
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.headers.get('Access-Control-Allow-Origin'), PAGES);
  const avatar = await call(`/api/avatar/${club.memberId}`, { invite: club.invite, token: accountToken });
  assert.equal(avatar.status, 200);
  assert.equal(avatar.headers.get('Content-Type'), 'image/png');
  assert.equal(avatar.headers.get('Access-Control-Allow-Origin'), PAGES);
  assert.match(avatar.headers.get('Vary'), /Origin/);
  assert.deepEqual(Buffer.from(await avatar.arrayBuffer()), PNG);
  const missing = await call(`/api/avatar/${crypto.randomUUID()}`, { invite: club.invite, token: accountToken });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('Access-Control-Allow-Origin'), PAGES);
  const denied = await call('/api/clubs', {
    method: 'POST', origin: 'https://attacker.test', body: { name: '不能创建', nickname: '攻击者' },
    headers: { Host: 'attacker.test', 'X-Forwarded-Host': 'attacker.test', 'X-Forwarded-Proto': 'https' }
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
  const invalidTarget = await call('//attacker.test/api/clubs', { method: 'POST', body: { name: '不能切换来源', nickname: '攻击者' } });
  assert.equal(invalidTarget.status, 400);
  assert.equal(invalidTarget.headers.get('Access-Control-Allow-Origin'), PAGES);
  assert.equal((await call('/private/tennis.sqlite')).status, 404);
});

test('HTTP size limits include chunked JSON and oversized avatars, and errors remain readable by Pages', async t => {
  const fixture = await httpFixture(t), call = api(fixture.url), club = await newClub(call);
  const preflight = await call('/api/profile', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,x-tennis-session' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), PAGES);
  for (const [path, rawBody, contentType] of [
    ['/api/profile', JSON.stringify({ nickname: 'x'.repeat(21000) }), 'application/json'],
    ['/api/avatar', Buffer.alloc(2 * 1024 * 1024 + 1), 'image/png']
  ]) {
    const tooLarge = await call(path, { method: 'POST', ...club, rawBody, headers: { 'Content-Type': contentType } });
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.headers.get('Access-Control-Allow-Origin'), PAGES);
    assert.ok((await tooLarge.json()).error);
  }
  const stream = new ReadableStream({ start(controller) { for (let n = 0; n < 4; n++) controller.enqueue(new TextEncoder().encode('x'.repeat(8000))); controller.close(); } });
  const chunked = await call('/api/profile', { method: 'POST', ...club, rawBody: stream, duplex: 'half', headers: { 'Content-Type': 'application/json' } });
  assert.equal(chunked.status, 413);
  assert.equal(chunked.headers.get('Access-Control-Allow-Origin'), PAGES);
  const encoded = await call('/api/profile', { method: 'POST', ...club, body: { nickname: 'Chris' }, headers: { 'Content-Encoding': 'gzip' } });
  assert.equal(encoded.status, 415);
  assert.equal(encoded.headers.get('Access-Control-Allow-Origin'), PAGES);
  const unauthorized = await call('/api/board');
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('Access-Control-Allow-Origin'), PAGES);
});

test('untrusted connecting-IP and forwarding headers cannot bypass the default address failure budget', async t => {
  const fixture = await httpFixture(t), call = api(fixture.url);
  for (let n = 0; n < 31; n++) {
    const denied = await call('/api/auth/login', {
      method: 'POST', body: { recoveryCode: `invalid-${n}` },
      headers: { 'CF-Connecting-IP': `198.51.100.${n + 1}`, 'X-Forwarded-For': `203.0.113.${n + 1}` }
    });
    assert.equal(denied.status, n < 30 ? 401 : 429);
    await denied.json();
  }
  assert.equal((await fixture.DB.prepare('SELECT COUNT(*) AS n FROM auth_failures').bind().first()).n, 1);
});

test('explicit proxy-hop trust selects the configured valid address and rejects arbitrary client prefixes', async t => {
  for (const hops of [1, 2]) {
    const fixture = await httpFixture(t, hops), call = api(fixture.url);
    const chain = (client, address) => [client, address, ...(hops === 2 ? ['192.0.2.200'] : [])].join(', ');
    const attempt = forwarded => call('/api/auth/login', { method: 'POST', body: { recoveryCode: 'invalid' }, headers: { 'X-Forwarded-For': forwarded, 'CF-Connecting-IP': nonce() } });
    for (const forwarded of [chain('198.51.100.1', '203.0.113.20'), chain('198.51.100.99', '203.0.113.20'), chain('198.51.100.2', '203.0.113.21')]) {
      const response = await attempt(forwarded); assert.equal(response.status, 401); await response.json();
    }
    const counters = await fixture.DB.prepare('SELECT failures FROM auth_failures ORDER BY failures').bind().all();
    assert.deepEqual(counters.results.map(row => row.failures), [1, 2]);
    for (const forwarded of [chain('not-an-ip', '203.0.113.20'), chain('another-invalid-prefix', '203.0.113.99')]) {
      const response = await attempt(forwarded); assert.equal(response.status, 401); await response.json();
    }
    const validated = await fixture.DB.prepare('SELECT failures FROM auth_failures ORDER BY failures').bind().all();
    assert.deepEqual(validated.results.map(row => row.failures), [1, 2, 2]);
  }
});

async function startProcess(directory) {
  const child = spawn(process.execPath, ['server/main.mjs'], {
    cwd: ROOT, env: { ...process.env, PUBLIC_API_ORIGIN: PUBLIC_ORIGIN, DATA_DIR: directory, PORT: '0', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '', pending = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Node backend startup timed out: ' + stderr)); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Node backend exited before listening (${code}): ${stderr}`)); });
    child.stdout.on('data', chunk => {
      pending += chunk.toString();
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try { const entry = JSON.parse(line); if (entry.event === 'listening') { clearTimeout(timer); resolve(entry.port); } } catch {}
      }
    });
  });
  return { child, url: `http://127.0.0.1:${port}` };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

test('a real server process restart retains recovery identity, training, and avatar files', { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tennis-node-restart-'));
  let running;
  t.after(async () => { await stopProcess(running?.child); rmSync(directory, { recursive: true, force: true }); });
  running = await startProcess(directory);
  const seedDatabase = createDatabase({ filename: join(directory, 'tennis.sqlite'), migrationsDir: MIGRATIONS });
  let call = api(running.url, fetch, seedDatabase);
  assert.equal((await call('/healthz')).status, 200);
  const club = await newClub(call);
  seedDatabase.close();
  const registered = await call('/api/auth/register', { method: 'POST', ...club, body: { registrationNonce: club.registrationNonce } });
  assert.equal(registered.status, 200);
  const saved = await registered.json();
  const recordId = crypto.randomUUID();
  const record = { id: recordId, playDate: '2026-01-20', minutes: 75, mood: '认真练球', skills: { forehand: 6, backhand: 5, serve: 7, return_skill: 6, net: 4, footwork: 8 }, training: { projects: ['serve', 'footwork'], content: '二发与回位', effect: 'some', effectNote: '二发更稳定', nextPlan: '落点控制' } };
  assert.equal((await call('/api/records', { method: 'POST', invite: club.invite, token: saved.sessionToken, body: record })).status, 201);
  assert.equal((await call('/api/avatar', { method: 'POST', invite: club.invite, token: saved.sessionToken, rawBody: PNG, headers: { 'Content-Type': 'image/png' } })).status, 200);
  await stopProcess(running.child);
  running = await startProcess(directory);
  call = api(running.url);
  const restored = await call('/api/auth/login', { method: 'POST', body: { recoveryCode: saved.recoveryCode } });
  assert.equal(restored.status, 200);
  const identity = await restored.json();
  assert.equal(identity.account.id, saved.account.id);
  const token = identity.sessionToken;
  const board = await (await call(`/api/board?club=${club.clubId}`, { token })).json();
  assert.equal(board.me, club.memberId);
  assert.equal(board.club.ownerId, club.memberId);
  assert.equal(board.records[0].id, recordId);
  assert.equal(board.members[0].hasAvatar, true);
  const growth = await (await call(`/api/growth?club=${club.clubId}`, { token })).json();
  assert.equal(growth.summary.training_sessions, 1);
  assert.equal(growth.summary.training_minutes, 75);
  assert.equal(growth.nextPlan.next_plan, '落点控制');
  assert.equal(growth.history[0].samples, 1);
  const avatar = await call(`/api/avatar/${club.memberId}`, { invite: club.invite, token });
  assert.equal(avatar.status, 200);
  assert.equal(avatar.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(Buffer.from(await avatar.arrayBuffer()), PNG);
  assert.equal((await (await call(`/api/board?club=${club.clubId}`, { token: saved.sessionToken })).json()).me, club.memberId);
});

async function migrationReceipt(DB, overrides = {}) {
  const tableCounts = {};
  for (const table of DATA_TABLES) tableCounts[table] = (await DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
  return {
    formatVersion: 1, appId: 'tennis-dazi-club-2026', schemaVersion: 5,
    migrationId: MIGRATION_ID, fromApiOrigin: FROM_ORIGIN, toApiOrigin: PUBLIC_ORIGIN, pageBaseUrl: PAGE_BASE,
    credentialsPreserved: true, sourceSnapshotSha256: 'a'.repeat(64), importedAt: new Date().toISOString(),
    tableCounts, avatarCount: 0, ...overrides
  };
}

const migrationService = ({ directory, DB }) => createMigrationService({ DB, dataDir: directory, publicOrigin: PUBLIC_ORIGIN, migrationId: MIGRATION_ID, fromApiOrigin: FROM_ORIGIN, pageBaseUrl: PAGE_BASE });

async function databaseSnapshot(DB) {
  const snapshot = {};
  for (const table of DATA_TABLES) snapshot[table] = (await DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
  return JSON.stringify(snapshot);
}

async function readyMigrationFixture(t) {
  let identities;
  const fixture = await httpFixture(t, 0, async context => {
    const { env, DB, directory } = context;
    const call = api(PUBLIC_ORIGIN, (url, options) => compiledWorker.fetch(new Request(url, options), env), DB);
    const bound = await newClub(call);
    const registration = await call('/api/auth/register', { method: 'POST', ...bound, body: { registrationNonce: bound.registrationNonce } });
    assert.equal(registration.status, 200);
    const account = await registration.json();
    const unbound = await newClub(call);
    const additional = await call('/api/invite', { method: 'POST', ...unbound, body: {} });
    assert.equal(additional.status, 200);
    const alternateInvite = (await additional.json()).invite;
    const recordId = crypto.randomUUID();
    assert.equal((await call('/api/records', { method: 'POST', invite: bound.invite, token: account.sessionToken, body: { id: recordId, playDate: '2026-01-20', minutes: 60, mood: '认真练球', note: '保留迁移前记录' } })).status, 201);
    assert.equal((await call('/api/checkins', { method: 'POST', invite: bound.invite, token: account.sessionToken, body: {} })).status, 200);
    assert.equal((await call('/api/cheers', { method: 'POST', invite: bound.invite, token: account.sessionToken, body: { recordId, emoji: '🎾' } })).status, 200);
    assert.equal((await call('/api/culture', { method: 'POST', invite: bound.invite, token: account.sessionToken, body: { id: crypto.randomUUID(), content: '继续挥拍' } })).status, 201);
    assert.equal((await call('/api/avatar', { method: 'POST', invite: bound.invite, token: account.sessionToken, rawBody: PNG, headers: { 'Content-Type': 'image/png' } })).status, 200);
    identities = { bound, unbound, account, alternateInvite };
    writeFileSync(join(directory, 'migration-receipt.json'), JSON.stringify(await migrationReceipt(DB, { avatarCount: 1 })), { mode: 0o600 });
    const service = await migrationService(context);
    assert.equal(service.ready, true);
    return service;
  });
  return { ...fixture, ...identities };
}

test('migration mode blocks ordinary APIs until a private matching import receipt exists while health remains available', async t => {
  for (const invalid of ['missing', 'wrong-id', 'public-file', 'incomplete-counts']) {
    const fixture = await httpFixture(t, 0, async context => {
      if (invalid !== 'missing') {
        const receipt = await migrationReceipt(context.DB, invalid === 'wrong-id' ? { migrationId: 'b'.repeat(64) } : invalid === 'incomplete-counts' ? { tableCounts: { accounts: 0 } } : {});
        const filename = join(context.directory, 'migration-receipt.json');
        writeFileSync(filename, JSON.stringify(receipt), { mode: 0o600 });
        if (invalid === 'public-file') chmodSync(filename, 0o644);
      }
      const service = await migrationService(context);
      assert.equal(service.enabled, true);
      assert.equal(service.ready, false);
      return service;
    });
    const call = api(fixture.url);
    assert.equal((await call('/healthz')).status, 200);
    for (const path of ['/api/auth/me', '/api/board', '/api/migration']) {
      const waiting = await call(path);
      assert.equal(waiting.status, 503);
      assert.equal(waiting.headers.get('Access-Control-Allow-Origin'), PAGES);
      assert.equal((await waiting.json()).ready, false);
    }
    assert.equal((await call('/api/clubs', { method: 'POST', body: { name: '不能创建空白群', nickname: 'Chris' } })).status, 503);
    assert.equal((await fixture.DB.prepare('SELECT COUNT(*) AS n FROM clubs').first()).n, 0);
    assert.equal((await fixture.DB.prepare('SELECT COUNT(*) AS n FROM accounts').first()).n, 0);
  }
});

test('migration validation accepts only preserved account/member/claim/registration proofs without writing or exposing credentials', async t => {
  const fixture = await readyMigrationFixture(t), call = api(fixture.url);
  const { bound, unbound, account, alternateInvite } = fixture;
  const manifest = await call('/api/migration');
  assert.equal(manifest.status, 200);
  const metadata = await manifest.json();
  assert.equal(metadata.migrationId, MIGRATION_ID);
  assert.equal(metadata.appId, 'tennis-dazi-club-2026');
  assert.equal(metadata.fromApiOrigin, FROM_ORIGIN);
  assert.equal(metadata.toApiOrigin, PUBLIC_ORIGIN);
  assert.equal(metadata.pageBaseUrl, PAGE_BASE);
  const proofs = [
    { proofId: 'account', kind: 'account', token: account.sessionToken },
    { proofId: 'member', kind: 'member', token: unbound.token, invite: unbound.invite },
    { proofId: 'member-without-invite', kind: 'member', token: unbound.token },
    { proofId: 'member-extra-invite', kind: 'member', token: unbound.token, invite: alternateInvite },
    { proofId: 'claim', kind: 'claim', token: unbound.token, clubId: unbound.clubId },
    { proofId: 'registration-unbound', kind: 'registration', token: unbound.token, clubId: unbound.clubId, registrationNonce: unbound.registrationNonce },
    { proofId: 'registration-receipt', kind: 'registration', token: bound.token, clubId: bound.clubId, registrationNonce: bound.registrationNonce },
    { proofId: 'wrong-token', kind: 'account', token: 'b'.repeat(64) },
    { proofId: 'wrong-invite', kind: 'member', token: unbound.token, invite: 'b'.repeat(64) },
    { proofId: 'member-wrong-club-invite', kind: 'member', token: unbound.token, invite: bound.invite },
    { proofId: 'wrong-club', kind: 'claim', token: unbound.token, clubId: bound.clubId },
    { proofId: 'bound-is-not-member', kind: 'member', token: bound.token, invite: bound.invite },
    { proofId: 'bound-is-not-member-without-invite', kind: 'member', token: bound.token },
    { proofId: 'bound-is-not-claim', kind: 'claim', token: bound.token, clubId: bound.clubId },
    { proofId: 'wrong-nonce', kind: 'registration', token: bound.token, clubId: bound.clubId, registrationNonce: nonce() },
    { proofId: 'wrong-kind', kind: 'anything', token: unbound.token },
    { proofId: 'malformed-token', kind: 'account', token: 'invalid' },
    { proofId: 'malformed-token-array', kind: 'account', token: [account.sessionToken] },
    { proofId: 'malformed-invite-array', kind: 'member', token: unbound.token, invite: [unbound.invite] }
  ];
  const before = await databaseSnapshot(fixture.DB);
  const response = await call('/api/migration/validate', { method: 'POST', body: { migrationId: MIGRATION_ID, proofs } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), PAGES);
  const accepted = await response.json();
  assert.deepEqual(accepted.acceptedProofIds, ['account', 'member', 'member-without-invite', 'member-extra-invite', 'claim', 'registration-unbound', 'registration-receipt']);
  for (const secret of [bound.token, bound.invite, unbound.token, unbound.invite, alternateInvite, account.sessionToken, account.recoveryCode, bound.registrationNonce]) assert.equal(JSON.stringify(accepted).includes(secret), false);
  assert.equal(await databaseSnapshot(fixture.DB), before);
  assert.equal((await fixture.DB.prepare('SELECT COUNT(*) AS n FROM auth_failures').first()).n, 0);
});

test('migration proof checks reject rotated or expired registrations and expired sessions without cleanup writes', async t => {
  const fixture = await readyMigrationFixture(t), call = api(fixture.url), { bound, account } = fixture;
  const rotation = await call('/api/auth/recovery', { method: 'POST', token: account.sessionToken, body: {} });
  assert.equal(rotation.status, 200);
  const proofs = [
    { proofId: 'account', kind: 'account', token: account.sessionToken },
    { proofId: 'receipt', kind: 'registration', token: bound.token, clubId: bound.clubId, registrationNonce: bound.registrationNonce }
  ];
  let before = await databaseSnapshot(fixture.DB);
  const rotated = await call('/api/migration/validate', { method: 'POST', body: { migrationId: MIGRATION_ID, proofs } });
  assert.deepEqual((await rotated.json()).acceptedProofIds, ['account']);
  assert.equal(await databaseSnapshot(fixture.DB), before);
  await fixture.DB.prepare('UPDATE auth_registrations SET expires_at=?').bind(Date.now() - 1000).run();
  await fixture.DB.prepare('UPDATE account_sessions SET expires_at=?').bind(Date.now() - 1000).run();
  before = await databaseSnapshot(fixture.DB);
  const expired = await call('/api/migration/validate', { method: 'POST', body: { migrationId: MIGRATION_ID, proofs } });
  assert.deepEqual((await expired.json()).acceptedProofIds, []);
  assert.equal(expired.headers.get('Set-Cookie'), null);
  assert.equal(await databaseSnapshot(fixture.DB), before);
});

test('migration validation enforces proof IDs, count, migration tuple, request size, and origins', async t => {
  const fixture = await readyMigrationFixture(t), call = api(fixture.url);
  for (const migrationId of ['node-migration-test-2026', 'A'.repeat(64)]) {
    await assert.rejects(createMigrationService({ DB: fixture.DB, dataDir: fixture.directory, publicOrigin: PUBLIC_ORIGIN, migrationId, fromApiOrigin: FROM_ORIGIN, pageBaseUrl: PAGE_BASE }), /MIGRATION_ID/);
  }
  const proof = { proofId: 'valid-id', kind: 'account', token: fixture.account.sessionToken };
  for (const body of [
    { migrationId: 'b'.repeat(64), proofs: [proof] },
    { migrationId: MIGRATION_ID, proofs: [{ ...proof, proofId: 'x'.repeat(81) }] },
    { migrationId: MIGRATION_ID, proofs: [{ ...proof, proofId: 'invalid.id' }] },
    { migrationId: MIGRATION_ID, proofs: [proof, proof] },
    { migrationId: MIGRATION_ID, proofs: Array.from({ length: 101 }, (_, i) => ({ ...proof, proofId: `proof-${i}` })) }
  ]) {
    const denied = await call('/api/migration/validate', { method: 'POST', body });
    assert.equal(denied.status, 400);
    assert.equal(denied.headers.get('Access-Control-Allow-Origin'), PAGES);
  }
  const hundred = await call('/api/migration/validate', { method: 'POST', body: { migrationId: MIGRATION_ID, proofs: Array.from({ length: 100 }, (_, i) => ({ ...proof, proofId: `proof-${i}` })) } });
  assert.equal(hundred.status, 200);
  assert.equal((await hundred.json()).acceptedProofIds.length, 100);
  const oversized = await call('/api/migration/validate', { method: 'POST', body: { migrationId: MIGRATION_ID, proofs: [proof], padding: 'x'.repeat(21000) } });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.headers.get('Access-Control-Allow-Origin'), PAGES);
  const originDenied = await call('/api/migration/validate', { method: 'POST', origin: 'https://attacker.test', body: { migrationId: MIGRATION_ID, proofs: [proof] } });
  assert.equal(originDenied.status, 403);
  assert.equal(originDenied.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await call('/api/migration/validate')).status, 405);
});

test('raw Connection-nominated Origin stripping cannot bypass the mutation origin policy', async t => {
  const fixture = await httpFixture(t);
  const body = JSON.stringify({ name: '不能通过移除来源创建', nickname: '攻击者' });
  const response = await new Promise((resolve, reject) => {
    const request = httpRequest(fixture.url + '/api/clubs', { method: 'POST', headers: { Origin: 'https://attacker.test', Connection: 'Origin', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject); request.end(body);
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.ok(JSON.parse(response.body).error);
  assert.equal((await fixture.DB.prepare('SELECT COUNT(*) AS n FROM clubs').first()).n, 0);
});

test('maintenance HTTP mode serves health and rejects every API without a worker or storage', async t => {
  let workerCalls = 0;
  const server = createAppServer({
    publicOrigin: PUBLIC_ORIGIN, maintenanceMode: true,
    worker: { fetch() { workerCalls++; throw new Error('Maintenance must not call the worker'); } }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); });
  const call = api(`http://127.0.0.1:${server.address().port}`);
  assert.deepEqual(await (await call('/healthz')).json(), { ok: true, maintenance: true });
  for (const [path, method] of [['/api/board', 'GET'], ['/api/auth/me', 'GET'], ['/api/clubs', 'POST'], ['/api/migration', 'GET'], ['/api/migration/validate', 'POST'], ['/api/profile', 'OPTIONS']]) {
    const response = await call(path, { method, ...(method === 'POST' ? { body: {} } : {}) });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), PAGES);
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.equal((await response.json()).maintenance, true);
  }
  assert.equal(workerCalls, 0);
});

test('maintenance startup neither imports a worker nor creates a data directory or SQLite handle', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tennis-node-maintenance-'));
  const dataDir = join(directory, 'must-not-be-created');
  let backend;
  t.after(async () => { await backend?.close(); rmSync(directory, { recursive: true, force: true }); });
  backend = await startBackend({
    publicOrigin: PUBLIC_ORIGIN, dataDir, maintenanceMode: true, host: '127.0.0.1', port: 0,
    workerPath: join(directory, 'missing-worker.mjs'), migrationsDir: join(directory, 'missing-migrations')
  });
  assert.equal(existsSync(dataDir), false);
  const call = api(`http://127.0.0.1:${backend.port}`);
  assert.deepEqual(await (await call('/healthz')).json(), { ok: true, maintenance: true });
  assert.equal((await call('/api/auth/me')).status, 503);
  await backend.close();
  assert.equal(existsSync(dataDir), false);
  assert.equal(existsSync(join(dataDir, 'tennis.sqlite')), false);
  assert.equal(existsSync(join(dataDir, 'avatars')), false);
});
