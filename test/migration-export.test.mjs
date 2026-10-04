import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { cp, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { wrapMigrationExport, MIGRATION_EXPORT_TABLES } from '../scripts/migration-export-worker.mjs';
import { buildMigrationExport } from '../scripts/build-migration-export.mjs';
import { TABLE_NAMES, TABLE_COLUMNS, validateBackup, sha256 } from '../scripts/backup-format.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const API = 'https://old.example';
const ROUTE = '/api/_owner/migration-export';
const PAGES = 'https://zjwzkongqc.github.io';
const ADMIN = '9'.repeat(64);
const TIME = '2026-10-04T10:00:00.000Z';
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 7, 9]);
const avatarKey = `avatars/${id(2)}/${id(3)}/${id(4)}`;

function sourceTables() {
  const history = '完整历史感想，不截断。\n🎾'.repeat(2000);
  return {
    accounts: [{ id: id(1), display_name: '原球友', recovery_hash: 'a'.repeat(64), created_at: TIME }],
    clubs: [{ id: id(2), invite_hash: 'b'.repeat(64), name: '原微信群', slogan: history, owner_id: id(3), created_at: TIME }],
    members: [{ id: id(3), club_id: id(2), session_hash: 'c'.repeat(64), nickname: '原球友', avatar_key: avatarKey, bio: history, created_at: TIME, account_id: id(1) }],
    account_sessions: [{ session_hash: 'd'.repeat(64), account_id: id(1), expires_at: 1791108000000, created_at: TIME }],
    club_invites: [{ invite_hash: 'e'.repeat(64), club_id: id(2), created_at: TIME }],
    auth_failures: [{ key: 'ip:' + 'f'.repeat(64), window_start: 1791100800000, failures: 29 }],
    auth_registrations: [{ account_id: id(1), club_id: id(2), legacy_hash: 'c'.repeat(64), nonce_hash: '0'.repeat(64), expires_at: 1791104400000 }],
    records: [{ id: id(5), club_id: id(2), member_id: id(3), play_date: '2026-10-04', minutes: 120, partners: history, venue: '原球场', mood: '认真练球', note: history, created_at: TIME, forehand: 5, backhand: 6, serve: 7, net: 8, footwork: 9, return_skill: 10, training_projects: '["backhand","serve"]', training_content: history, training_effect: 'improved', effect_note: history, next_plan: history }],
    culture: [{ id: id(6), club_id: id(2), member_id: id(3), content: history, created_at: TIME }],
    cheers: [{ record_id: id(5), member_id: id(3), emoji: '🎾' }],
    checkins: [{ id: id(7), club_id: id(2), member_id: id(3), checkin_date: '2026-10-04', created_at: TIME }]
  };
}
function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  const migrations = path.join(ROOT, 'drizzle');
  for (const filename of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(path.join(migrations, filename), 'utf8'));
  t.after(() => sqlite.close());
  const tables = sourceTables();
  for (const table of TABLE_NAMES) {
    const columns = TABLE_COLUMNS[table];
    for (const row of tables[table]) sqlite.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column]));
  }
  const calls = { prepared: [], batches: 0, avatars: [], original: [] };
  const DB = {
    prepare(sql) { calls.prepared.push(sql); return { sql }; },
    async batch(statements) {
      calls.batches++;
      sqlite.exec('BEGIN');
      try {
        const result = statements.map(statement => ({ success: true, results: sqlite.prepare(statement.sql).all().map(row => ({ ...row })) }));
        sqlite.exec('COMMIT'); return result;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  const BUCKET = { async get(key) { calls.avatars.push(key); return key === avatarKey ? { size: PNG.length, httpMetadata: { contentType: 'image/png' }, arrayBuffer: async () => PNG.slice().buffer } : null; } };
  const env = { DB, BUCKET, TENNIS_MIGRATION_ADMIN_TOKEN: ADMIN, TENNIS_MIGRATION_FREEZE: '1' };
  const original = { async fetch(request, receivedEnv, context) { calls.original.push({ request, env: receivedEnv, context }); return new Response('original', { status: 207, headers: { 'Set-Cookie': 'original-cookie' } }); } };
  const wrapped = wrapMigrationExport(original);
  const request = (headers = {}, method = 'POST', route = ROUTE) => new Request(API + route, { method, headers: { 'X-Tennis-Migration-Admin': ADMIN, ...headers } });
  return { sqlite, tables, calls, env, wrapped, original, request };
}

test('export uses one atomic eleven-table batch and preserves full rows and every referenced avatar', async t => {
  const f = fixture(t);
  assert.deepEqual(MIGRATION_EXPORT_TABLES, TABLE_NAMES);
  const response = await f.wrapped.fetch(f.request(), f.env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  const body = await response.text(), snapshot = JSON.parse(body), valid = validateBackup(snapshot);
  assert.equal(body.includes(ADMIN), false);
  assert.equal(snapshot.fromApiOrigin, API);
  assert.deepEqual(snapshot.tables, f.tables);
  assert.equal(valid.avatarCount, 1);
  assert.deepEqual(snapshot.avatars, [{ key: avatarKey, contentType: 'image/png', dataBase64: Buffer.from(PNG).toString('base64'), sha256: sha256(PNG) }]);
  assert.deepEqual(f.calls.prepared, TABLE_NAMES.map(table => `SELECT * FROM ${table}`));
  assert.equal(f.calls.batches, 1);
  assert.deepEqual(f.calls.avatars, [avatarKey]);
  assert.equal(f.calls.original.length, 0);
});

test('missing, malformed, mismatched, and browser-supplied admin credentials make zero storage accesses', async t => {
  const f = fixture(t);
  const variants = [
    [{ ...f.env, TENNIS_MIGRATION_ADMIN_TOKEN: undefined }, f.request()],
    [{ ...f.env, TENNIS_MIGRATION_ADMIN_TOKEN: 'A'.repeat(64) }, f.request()],
    [f.env, new Request(API + ROUTE, { method: 'POST' })],
    [f.env, f.request({ 'X-Tennis-Migration-Admin': '8'.repeat(64) })],
    [f.env, f.request({ 'X-Tennis-Migration-Admin': 'A'.repeat(64) })],
    [f.env, f.request({ 'X-Tennis-Migration-Admin': '9'.repeat(63) })],
    [f.env, f.request({ Origin: PAGES })],
    [f.env, f.request({ Origin: 'null' })],
    [f.env, f.request({ Origin: '' })],
    [f.env, f.request({ Cookie: `tc_session=${ADMIN}` })],
    [f.env, f.request({ Authorization: `Bearer ${ADMIN}` })],
    [f.env, f.request({ 'X-Tennis-Session': ADMIN })],
    [f.env, new Request(API + ROUTE + '?admin=' + ADMIN, { method: 'POST', body: JSON.stringify({ token: ADMIN }) })],
    [f.env, f.request({}, 'GET')],
    [f.env, f.request({}, 'OPTIONS')]
  ];
  for (const [env, request] of variants) {
    const response = await f.wrapped.fetch(request, env);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal((await response.text()).includes(ADMIN), false);
  }
  assert.deepEqual(f.calls, { prepared: [], batches: 0, avatars: [], original: [] });
});

test('admin export requires the exact freeze flag before reading either storage binding', async t => {
  const f = fixture(t);
  for (const freeze of [undefined, '', '0', 1, true]) {
    const response = await f.wrapped.fetch(f.request(), { ...f.env, TENNIS_MIGRATION_FREEZE: freeze });
    assert.equal(response.status, 409);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.deepEqual(f.calls, { prepared: [], batches: 0, avatars: [], original: [] });
});

test('missing or invalid avatar bodies fail closed without partial snapshots or diagnostic leaks', async t => {
  const f = fixture(t);
  const logs = t.mock.method(console, 'error', () => {});
  const cases = [
    null,
    { size: PNG.length, httpMetadata: { contentType: 'image/jpeg' }, arrayBuffer: async () => PNG.buffer },
    { size: PNG.length + 1, httpMetadata: { contentType: 'image/png' }, arrayBuffer: async () => PNG.buffer },
    { size: PNG.length, httpMetadata: { contentType: 'image/png' }, arrayBuffer: async () => { throw new Error(ADMIN); } }
  ];
  for (const object of cases) {
    const response = await f.wrapped.fetch(f.request(), { ...f.env, BUCKET: { get: async () => object } });
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.equal(body.includes('tables'), false); assert.equal(body.includes(ADMIN), false);
    assert.equal(response.headers.get('Set-Cookie'), null);
  }
  let read = false;
  const response = await f.wrapped.fetch(f.request(), { ...f.env, BUCKET: { get: async () => ({ size: 2 * 1024 * 1024 + 1, arrayBuffer: async () => { read = true; } }) } });
  assert.equal(response.status, 503); assert.equal(read, false);
  assert.equal(logs.mock.callCount(), 0);
});

test('duplicate avatar references are exported once and unused objects are never requested', async t => {
  const f = fixture(t);
  f.sqlite.prepare('INSERT INTO members(id,club_id,session_hash,nickname,avatar_key,bio,created_at,account_id) VALUES(?,?,?,?,?,?,?,NULL)').run(id(8), id(2), '1'.repeat(64), '另一位原球友', avatarKey, '', TIME);
  const response = await f.wrapped.fetch(f.request(), f.env), snapshot = await response.json();
  assert.equal(response.status, 200);
  assert.equal(snapshot.tables.members.length, 2);
  assert.equal(snapshot.avatars.length, 1);
  assert.deepEqual(f.calls.avatars, [avatarKey]);
  assert.equal(validateBackup(snapshot).avatarCount, 1);
});

test('oversized table data is rejected before reading avatars and incomplete D1 batches are refused', async t => {
  const f = fixture(t);
  f.sqlite.prepare('UPDATE records SET note=?').run('x'.repeat(32 * 1024 * 1024));
  const response = await f.wrapped.fetch(f.request(), f.env);
  assert.equal(response.status, 503);
  assert.equal(f.calls.avatars.length, 0);
  for (const results of [[], TABLE_NAMES.map(() => ({ success: false, results: [] }))]) {
    const failed = await f.wrapped.fetch(f.request(), { ...f.env, DB: { prepare: sql => ({ sql }), batch: async () => results } });
    assert.equal(failed.status, 503);
  }
});

test('combined avatar JSON cannot exceed the total 32 MiB output limit', async t => {
  const f = fixture(t);
  f.sqlite.prepare('UPDATE records SET note=?').run('x'.repeat(28 * 1024 * 1024));
  const secondKey = `avatars/${id(2)}/${id(8)}/${id(9)}`;
  f.sqlite.prepare('INSERT INTO members(id,club_id,session_hash,nickname,avatar_key,bio,created_at,account_id) VALUES(?,?,?,?,?,?,?,NULL)').run(id(8), id(2), '1'.repeat(64), '第二位', secondKey, '', TIME);
  const bytes = new Uint8Array(2 * 1024 * 1024); bytes.set(PNG);
  let requested = 0;
  const response = await f.wrapped.fetch(f.request(), { ...f.env, BUCKET: { async get() { requested++; return { size: bytes.length, httpMetadata: { contentType: 'image/png' }, arrayBuffer: async () => bytes.buffer }; } } });
  assert.equal(response.status, 503);
  assert.equal(requested, 2);
  assert.equal((await response.text()).includes('tables'), false);
});

test('freeze blocks ordinary writes with readable Pages maintenance errors while preserving reads and unfreezing', async t => {
  const f = fixture(t), context = { marker: 'passed-through' };
  for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
    const request = new Request(API + '/api/records', { method, headers: { Origin: PAGES } });
    const response = await f.wrapped.fetch(request, f.env, context);
    assert.equal(response.status, 503); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), PAGES);
    assert.match((await response.json()).error, /迁移/);
    assert.equal(response.headers.get('Set-Cookie'), null);
  }
  assert.equal(f.calls.original.length, 0);
  const deniedOrigin = await f.wrapped.fetch(new Request(API + '/api/profile', { method: 'POST', headers: { Origin: 'https://evil.example' } }), f.env);
  assert.equal(deniedOrigin.headers.get('Access-Control-Allow-Origin'), null);
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const request = new Request(API + '/api/board', { method });
    const response = await f.wrapped.fetch(request, f.env, context);
    assert.equal(response.status, 207);
    assert.equal(f.calls.original.at(-1).request, request);
    assert.equal(f.calls.original.at(-1).context, context);
  }
  const normalEnv = { ...f.env, TENNIS_MIGRATION_FREEZE: undefined };
  const write = new Request(API + '/api/records', { method: 'POST' });
  assert.equal((await f.wrapped.fetch(write, normalEnv, context)).status, 207);
  assert.equal(f.calls.original.at(-1).env, normalEnv);
  assert.equal((await f.wrapped.fetch(new Request(API + '/'), f.env)).status, 207);
  assert.equal(f.calls.batches, 0); assert.equal(f.calls.avatars.length, 0);
});

test('temporary compilation preserves assets/config and normal builds never include the admin wrapper', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tennis-export-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(path.join(ROOT, 'src'), path.join(directory, 'src'), { recursive: true });
  await copyFile(path.join(ROOT, 'wrangler.json'), path.join(directory, 'wrangler.json'));
  const temporary = path.join(directory, 'temporary');
  await buildMigrationExport({ projectRoot: directory, outputDir: temporary });
  const compiled = await readFile(path.join(temporary, 'index.js'), 'utf8');
  const imported = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
  const response = await imported.default.fetch(new Request(API + '/'), {});
  assert.equal(response.status, 200);
  assert.match(await response.text(), /网球搭子/);
  assert.equal((await imported.default.fetch(new Request(API + ROUTE, { method: 'POST' }), {})).status, 404);
  const config = JSON.parse(await readFile(path.join(temporary, 'wrangler.json'), 'utf8'));
  assert.deepEqual(config, { ...JSON.parse(await readFile(path.join(directory, 'wrangler.json'), 'utf8')), main: 'index.js' });
  const normal = spawnSync(process.execPath, [path.join(ROOT, 'scripts/build.mjs')], { cwd: directory, encoding: 'utf8' });
  assert.equal(normal.status, 0, normal.stderr);
  assert.equal((await readFile(path.join(directory, 'dist/server/index.js'), 'utf8')).includes(ROUTE), false);
  assert.equal(compiled.includes(ADMIN), false);
});
