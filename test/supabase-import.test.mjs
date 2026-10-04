import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, readdir, rm, chmod, symlink, link, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { APP_ID, TABLE_NAMES, TABLE_COLUMNS, sha256, canonicalStringify, snapshotChecksum } from '../scripts/backup-format.mjs';
import { AVATAR_BUCKET, SupabaseImportError, createPrivateStorage, createOwnerDatabase, loadOwnerConfig, importSupabaseBackup, runSupabaseImportCli } from '../scripts/import-supabase-backup.mjs';
import { importPrivateSnapshot, validateSnapshot } from '../supabase/functions/tennis-api/import.mjs';

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const time = '2026-10-04T10:00:00.000Z';
const longText = '完整网球历史，换行、感想和训练计划。\n🎾'.repeat(4000);
const PRIVATE_MARKER = 'TEST-PRIVATE-OWNER-KEY-NEVER-PRINT';
const ownerConfig = { SUPABASE_URL: 'https://fixture.supabase.co', ADMIN_SERVICE_ROLE_KEY: PRIVATE_MARKER, OWNER_DB_URL: 'postgres://fixture:TEST-PRIVATE-PASSWORD@fixture.invalid/tennis' };
const integerColumns = new Set(['expires_at', 'window_start', 'failures', 'minutes', 'forehand', 'backhand', 'serve', 'return_skill', 'net', 'footwork']);

function snapshotFixture(twoAvatars = false) {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 7, 9]);
  const avatarKey = `avatars/${id(2)}/${id(3)}/${id(4)}`;
  const tables = Object.fromEntries(TABLE_NAMES.map(table => [table, []]));
  tables.accounts = [{ id: id(1), display_name: '原球友', recovery_hash: 'a'.repeat(64), created_at: time }];
  tables.clubs = [{ id: id(2), invite_hash: 'b'.repeat(64), name: '原微信群', slogan: longText, owner_id: id(3), created_at: time }];
  tables.members = [{ id: id(3), club_id: id(2), session_hash: 'c'.repeat(64), nickname: '原球友', avatar_key: avatarKey, bio: longText, created_at: time, account_id: id(1) }];
  tables.account_sessions = [{ session_hash: 'd'.repeat(64), account_id: id(1), expires_at: 1791108000000, created_at: time }];
  tables.club_invites = [{ invite_hash: 'e'.repeat(64), club_id: id(2), created_at: time }];
  tables.auth_failures = [{ key: 'ip:' + 'f'.repeat(64), window_start: 1791100800000, failures: 29 }];
  tables.auth_registrations = [{ account_id: id(1), club_id: id(2), legacy_hash: 'c'.repeat(64), nonce_hash: '0'.repeat(64), expires_at: 1791104400000 }];
  tables.records = [{ id: id(5), club_id: id(2), member_id: id(3), play_date: '2026-10-04', minutes: 120, partners: longText, venue: '原球场', mood: '认真练球', note: longText, created_at: time, forehand: 5, backhand: 6, serve: 7, net: 8, footwork: 9, return_skill: 10, training_projects: '["backhand","serve"]', training_content: longText, training_effect: 'improved', effect_note: longText, next_plan: longText }];
  tables.culture = [{ id: id(6), club_id: id(2), member_id: id(3), content: longText, created_at: time }];
  tables.cheers = [{ record_id: id(5), member_id: id(3), emoji: '🎾' }];
  tables.checkins = [{ id: id(7), club_id: id(2), member_id: id(3), checkin_date: '2026-10-04', created_at: time }];
  const avatars = [{ key: avatarKey, contentType: 'image/png', dataBase64: bytes.toString('base64'), sha256: sha256(bytes) }];
  if (twoAvatars) {
    const key = `avatars/${id(2)}/${id(8)}/${id(9)}`, second = Buffer.concat([bytes, Buffer.from([8, 10])]);
    tables.members.push({ ...tables.members[0], id: id(8), session_hash: '2'.repeat(64), account_id: null, avatar_key: key, nickname: '第二球友' });
    avatars.push({ key, contentType: 'image/png', dataBase64: second.toString('base64'), sha256: sha256(second) });
  }
  return { formatVersion: 1, appId: APP_ID, schemaVersion: 4, createdAt: time, fromApiOrigin: 'https://old.example', tables, avatars };
}
async function fixture(t, snapshot = snapshotFixture()) {
  const root = await mkdtemp(path.join(tmpdir(), 'tennis-supabase-import-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshotPath = path.join(root, 'snapshot.json'), configFile = path.join(root, 'owner.json');
  await writeFile(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 });
  await writeFile(configFile, JSON.stringify(ownerConfig), { mode: 0o600 });
  const options = { snapshotPath, migrationId: '12'.repeat(32), fromApiOrigin: 'https://old.example', toApiOrigin: ownerConfig.SUPABASE_URL, pageBaseUrl: 'https://owner.github.io/tennis/', config: ownerConfig };
  return { root, snapshot, options, configFile, rewrite: value => writeFile(snapshotPath, JSON.stringify(value), { mode: 0o600 }) };
}
async function sqliteTarget(t, behavior = {}) {
  const sql = new DatabaseSync(':memory:');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort()) sql.exec(await readFile(new URL(name, directory), 'utf8'));
  sql.exec('PRAGMA foreign_keys=ON; CREATE TABLE tennis_migration_receipt (id TEXT PRIMARY KEY, metadata TEXT NOT NULL)');
  t.after(() => sql.close());
  const events = [];
  const target = {
    sql, events,
    async verifySchema() { events.push('schema'); if (behavior.badSchema) throw new Error(PRIVATE_MARKER); },
    async assertEmpty() { events.push('empty'); if ([...TABLE_NAMES, 'tennis_migration_receipt'].some(table => sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)) throw new SupabaseImportError('The target contains application data or a migration receipt; import refused.'); },
    async insertRows(table, rows) {
      events.push('insert:' + table);
      const columns = TABLE_COLUMNS[table], statement = sql.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
      for (const row of rows) statement.run(...columns.map(column => row[column]));
    },
    async readRows(table) {
      const rows = sql.prepare(`SELECT ${TABLE_COLUMNS[table].join(',')} FROM ${table}`).all().map(row => ({ ...row }));
      if (behavior.numericStrings) for (const row of rows) for (const column of integerColumns) if (typeof row[column] === 'number') row[column] = String(row[column]);
      if (behavior.mismatch && table === 'records') rows[0].note += 'changed';
      return rows;
    },
    async writeReceipt(receipt) { events.push('receipt'); if (behavior.failReceipt) throw new Error(PRIVATE_MARKER); sql.prepare('INSERT INTO tennis_migration_receipt VALUES (?,?)').run('current', JSON.stringify(receipt)); },
    async transaction(callback) {
      if (behavior.concurrentWrite) sql.prepare('INSERT INTO auth_failures VALUES (?,?,?)').run('preserve-existing', 0, 1);
      sql.exec('BEGIN'); events.push('begin');
      try { await callback(target); if (behavior.commitUncertain) throw new SupabaseImportError('Commit acknowledgement was lost.', { commitUncertain: true }); sql.exec('COMMIT'); events.push('commit'); }
      catch (error) { sql.exec('ROLLBACK'); events.push('rollback'); throw error; }
    },
    counts() { return Object.fromEntries([...TABLE_NAMES, 'tennis_migration_receipt'].map(table => [table, sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n])); }
  };
  if (behavior.failLastTable) sql.exec("CREATE TRIGGER fixture_failure BEFORE INSERT ON checkins BEGIN SELECT RAISE(ABORT,'private fixture value must not print'); END");
  return target;
}
function memoryStorage(behavior = {}) {
  const objects = new Map(behavior.initialObjects || []), events = []; let uploaded = 0;
  return {
    objects, events,
    async assertPrivate() { events.push('private'); if (behavior.publicBucket) throw new SupabaseImportError('The avatar bucket must be private.'); },
    async upload(key, bytes, contentType) { events.push(['upload', key]); if (objects.has(key)) throw new SupabaseImportError('An avatar object already exists; overwrite refused.', { existingObject: true }); if (++uploaded === behavior.failUpload) throw new Error(PRIVATE_MARKER); objects.set(key, { bytes: Buffer.from(bytes), contentType }); },
    async download(key) { events.push(['get', key]); const object = objects.get(key); return { ...object, bytes: behavior.badHash ? Buffer.from('not the original private avatar') : Buffer.from(object.bytes) }; },
    async remove(keys) { events.push(['cleanup', [...keys]]); if (behavior.failCleanup) throw new Error(PRIVATE_MARKER); for (const key of keys) objects.delete(key); }
  };
}
function assertEmpty(target) { assert.deepEqual(target.counts(), Object.fromEntries([...TABLE_NAMES, 'tennis_migration_receipt'].map(table => [table, 0]))); }

test('Supabase import preserves all eleven tables, long text, IDs, credentials, expiry, and avatar bytes before writing the receipt', async t => {
  const f = await fixture(t, snapshotFixture(true)); f.snapshot.checksum = snapshotChecksum(f.snapshot); await f.rewrite(f.snapshot);
  const database = await sqliteTarget(t, { numericStrings: true }), storage = memoryStorage();
  const receipt = await importSupabaseBackup(f.options, { database, storage });
  for (const table of TABLE_NAMES) {
    const actual = database.sql.prepare(`SELECT ${TABLE_COLUMNS[table].join(',')} FROM ${table}`).all().map(row => canonicalStringify({ ...row })).sort();
    assert.deepEqual(actual, f.snapshot.tables[table].map(canonicalStringify).sort());
  }
  assert.equal(database.sql.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(database.sql.prepare('SELECT note FROM records').get().note, longText);
  for (const avatar of f.snapshot.avatars) assert.equal(sha256(storage.objects.get(avatar.key).bytes), avatar.sha256);
  assert.equal(receipt.sourceSnapshotSha256, sha256(await readFile(f.options.snapshotPath)));
  assert.equal(receipt.avatarCount, 2); assert.equal(receipt.credentialsPreserved, true);
  assert.deepEqual(receipt.tableCounts, Object.fromEntries(TABLE_NAMES.map(table => [table, f.snapshot.tables[table].length])));
  assert.deepEqual(JSON.parse(database.sql.prepare('SELECT metadata FROM tennis_migration_receipt').get().metadata), receipt);
  assert.deepEqual(database.events.slice(-2), ['receipt', 'commit']);
  assert.equal(JSON.stringify(receipt).includes(PRIVATE_MARKER), false);
});

test('invalid schema, missing objects, bad avatar hash, foreign keys, duplicates, and altered columns stop before any upload or SQL writes', async t => {
  const mutations = [
    value => { value.schemaVersion = 3; }, value => { delete value.tables.culture; },
    value => { value.avatars = []; }, value => { value.avatars[0].sha256 = '9'.repeat(64); },
    value => { value.tables.members[0].account_id = id(999); }, value => { value.tables.checkins.push({ ...value.tables.checkins[0] }); },
    value => { value.tables.accounts[0].secret = PRIVATE_MARKER; }, value => { value.tables.records[0].note = '\ud800'; }
  ];
  const f = await fixture(t), database = await sqliteTarget(t), storage = memoryStorage();
  for (const mutate of mutations) {
    const snapshot = snapshotFixture(); mutate(snapshot); await f.rewrite(snapshot);
    await assert.rejects(importSupabaseBackup(f.options, { database, storage }), /complete version, row, relationship, or avatar validation/);
    assertEmpty(database); assert.deepEqual(storage.events, []);
  }
  assert.deepEqual(database.events, []);
});

test('nonempty rows and prior receipts are refused before staging; a concurrent writer is preserved when the locked empty check fails', async t => {
  for (const table of ['auth_failures', 'tennis_migration_receipt']) {
    const f = await fixture(t), database = await sqliteTarget(t), storage = memoryStorage();
    if (table === 'auth_failures') database.sql.prepare('INSERT INTO auth_failures VALUES (?,?,?)').run('private-existing', 0, 1);
    else database.sql.prepare('INSERT INTO tennis_migration_receipt VALUES (?,?)').run('current', '{}');
    const before = database.counts();
    await assert.rejects(importSupabaseBackup(f.options, { database, storage }), /target contains/);
    assert.deepEqual(database.counts(), before); assert.equal(storage.events.length, 0);
  }
  const f = await fixture(t), database = await sqliteTarget(t, { concurrentWrite: true }), storage = memoryStorage();
  await assert.rejects(importSupabaseBackup(f.options, { database, storage }), /target contains/);
  assert.equal(database.sql.prepare('SELECT key FROM auth_failures').get().key, 'preserve-existing');
  assert.equal(database.counts().tennis_migration_receipt, 0); assert.equal(database.counts().accounts, 0); assert.equal(storage.objects.size, 1);
});

test('failed staged uploads and hash checks retain private objects for safe retry and never overwrite or delete existing objects', async t => {
  const snapshot = snapshotFixture(true), otherKey = 'avatars/not-owned-by-this-import', original = { bytes: Buffer.from('preserve'), contentType: 'image/png' };
  for (const behavior of [{ failUpload: 2 }, { badHash: true }]) {
    const f = await fixture(t, snapshot), database = await sqliteTarget(t), storage = memoryStorage({ ...behavior, initialObjects: [[otherKey, original]] });
    await assert.rejects(importSupabaseBackup(f.options, { database, storage }));
    assertEmpty(database); assert.deepEqual([...storage.objects.keys()], [otherKey, snapshot.avatars[0].key]); assert.equal(storage.objects.get(otherKey), original);
    assert.equal(storage.events.some(event => Array.isArray(event) && event[0] === 'cleanup'), false);
  }
  const f = await fixture(t, snapshot), database = await sqliteTarget(t), existingKey = snapshot.avatars[1].key;
  const storage = memoryStorage({ initialObjects: [[existingKey, original]] });
  await assert.rejects(importSupabaseBackup(f.options, { database, storage }), /overwrite refused/);
  assertEmpty(database); assert.deepEqual([...storage.objects.keys()], [existingKey, snapshot.avatars[0].key]); assert.equal(storage.objects.get(existingKey), original);
});

test('late SQL failure, receipt failure, and readback mismatch roll back all rows and the receipt while preserving private staged avatars', async t => {
  for (const behavior of [{ failLastTable: true }, { failReceipt: true }, { mismatch: true }]) {
    const f = await fixture(t), database = await sqliteTarget(t, behavior), storage = memoryStorage();
    const error = await importSupabaseBackup(f.options, { database, storage }).then(() => null, error => error);
    assert.equal(error instanceof SupabaseImportError, true); assert.equal(error.message.includes(PRIVATE_MARKER), false);
    assertEmpty(database); assert.equal(storage.objects.size, 1); assert.equal(database.events.at(-1), 'rollback');
    assert.match(error.message, /retained for safe retry or owner inspection/);
    assert.equal(storage.events.some(event => Array.isArray(event) && event[0] === 'cleanup'), false);
  }
});

test('retry reuses only byte-and-type-identical private avatars and failed imports never issue delayed deletes', async t => {
  const snapshot = snapshotFixture(true), first = snapshot.avatars[0], existing = { bytes: Buffer.from(first.dataBase64, 'base64'), contentType: first.contentType };
  const f = await fixture(t, snapshot), database = await sqliteTarget(t, { failReceipt: true }), storage = memoryStorage({ initialObjects: [[first.key, existing]] });
  await assert.rejects(importSupabaseBackup(f.options, { database, storage }));
  assertEmpty(database); assert.deepEqual([...storage.objects.keys()], snapshot.avatars.map(avatar => avatar.key)); assert.equal(storage.objects.get(first.key), existing);
  assert.equal(storage.events.some(event => Array.isArray(event) && event[0] === 'cleanup'), false);
  const successful = await sqliteTarget(t), receipt = await importSupabaseBackup(f.options, { database: successful, storage });
  assert.equal(receipt.avatarCount, 2); assert.equal(storage.objects.get(first.key), existing); assert.equal(storage.objects.size, 2);
});

test('the pure Web entry point validates its exact trusted metadata and source hash before acquiring a lock or touching data', async t => {
  const f = await fixture(t), database = await sqliteTarget(t), bucket = memoryStorage(), snapshotJson = await readFile(f.options.snapshotPath, 'utf8');
  const metadata = { migrationId: f.options.migrationId, fromApiOrigin: f.options.fromApiOrigin, toApiOrigin: f.options.toApiOrigin, pageBaseUrl: f.options.pageBaseUrl, sourceSnapshotSha256: sha256(snapshotJson) };
  for (const change of [{ sourceSnapshotSha256: '9'.repeat(64) }, { migrationId: 'x'.repeat(64) }, { extra: PRIVATE_MARKER }, { pageBaseUrl: undefined }]) await assert.rejects(importPrivateSnapshot({ snapshotJson, metadata: { ...metadata, ...change }, db: database, bucket }));
  assert.deepEqual(database.events, []); assert.deepEqual(bucket.events, []);
  const validated = await validateSnapshot(f.snapshot); assert.equal(validated.avatars.get(f.snapshot.avatars[0].key).bytes instanceof Uint8Array, true);
});

test('unknown commit acknowledgement and database failures retain private staged objects without declaring success or issuing deletes', async t => {
  const f = await fixture(t), database = await sqliteTarget(t, { commitUncertain: true }), storage = memoryStorage();
  await assert.rejects(importSupabaseBackup(f.options, { database, storage }), error => error.commitUncertain === true);
  assert.equal(storage.objects.size, 1); assert.equal(storage.events.some(event => Array.isArray(event) && event[0] === 'cleanup'), false);
  const failed = await fixture(t), failedDb = await sqliteTarget(t, { failReceipt: true }), failedStorage = memoryStorage({ failCleanup: true });
  await assert.rejects(importSupabaseBackup(failed.options, { database: failedDb, storage: failedStorage }), error => /retained for safe retry/.test(error.message) && !error.message.includes(PRIVATE_MARKER));
  assertEmpty(failedDb); assert.equal(failedStorage.events.some(event => Array.isArray(event) && event[0] === 'cleanup'), false);
  const lost = await fixture(t), lostDb = await sqliteTarget(t), lostStorage = memoryStorage();
  lostDb.transaction = async () => { throw new Error(PRIVATE_MARKER); };
  await assert.rejects(importSupabaseBackup(lost.options, { database: lostDb, storage: lostStorage }), /owner inspection/);
  assertEmpty(lostDb); assert.equal(lostStorage.objects.size, 1); assert.equal(lostStorage.events.some(event => Array.isArray(event) && event[0] === 'cleanup'), false);
});

test('owner config and snapshots require explicit private sources, mode0600, one hard link, and no symlink; invalid metadata never guesses configuration', async t => {
  const f = await fixture(t), database = await sqliteTarget(t), storage = memoryStorage();
  assert.deepEqual(await loadOwnerConfig({ configFile: f.configFile }), ownerConfig);
  assert.deepEqual(await loadOwnerConfig({ configStdin: true }, { stdin: Readable.from([JSON.stringify(ownerConfig)]) }), ownerConfig);
  assert.deepEqual(await loadOwnerConfig({ configEnv: true }, { env: ownerConfig }), ownerConfig);
  await assert.rejects(loadOwnerConfig({}, { env: ownerConfig }), /exactly one/);
  await assert.rejects(loadOwnerConfig({ configEnv: true }, { env: {} }), /three explicit/);
  await assert.rejects(loadOwnerConfig({ configStdin: true, configEnv: true }), /exactly one/);
  await chmod(f.configFile, 0o644); await assert.rejects(loadOwnerConfig({ configFile: f.configFile }), /mode 0600/); await chmod(f.configFile, 0o600);
  const alias = path.join(f.root, 'config-alias.json'); await symlink(f.configFile, alias);
  await assert.rejects(loadOwnerConfig({ configFile: alias }), /could not be read/);
  const second = path.join(f.root, 'second-snapshot.json'); await link(f.options.snapshotPath, second);
  await assert.rejects(importSupabaseBackup(f.options, { database, storage }), /exactly one hard link/); await unlink(second);
  await chmod(f.options.snapshotPath, 0o644); await assert.rejects(importSupabaseBackup(f.options, { database, storage }), /mode 0600/); await chmod(f.options.snapshotPath, 0o600);
  const snapshotAlias = path.join(f.root, 'snapshot-alias.json'); await symlink(f.options.snapshotPath, snapshotAlias);
  await assert.rejects(importSupabaseBackup({ ...f.options, snapshotPath: snapshotAlias }, { database, storage }), /could not be read/);
  for (const change of [{ migrationId: 'wrong' }, { toApiOrigin: 'https://other.supabase.co' }, { fromApiOrigin: 'https://forged.example' }, { pageBaseUrl: undefined }, { config: { ...ownerConfig, SUPABASE_URL: 'http://fixture.supabase.co' } }]) await assert.rejects(importSupabaseBackup({ ...f.options, ...change }, { database, storage }));
  assertEmpty(database); assert.deepEqual(storage.events, []);
});

test('Storage API uses private bucket, non-overwriting uploads and owner headers only; server responses never become printed errors', async () => {
  const requests = [], bytes = Buffer.from('synthetic bytes'), key = 'avatars/group/member/image';
  const storage = createPrivateStorage(ownerConfig, async (url, options) => {
    requests.push({ url, options });
    if (url.includes('/bucket/')) return Response.json({ id: AVATAR_BUCKET, public: false });
    if (!options.method) return new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
    return Response.json({});
  });
  await storage.assertPrivate(); await storage.upload(key, bytes, 'image/png'); assert.deepEqual(Buffer.from((await storage.download(key)).bytes), bytes); await storage.remove([key]);
  for (const request of requests) {
    assert.equal(request.url.includes(PRIVATE_MARKER), false); assert.equal(request.url.includes('TEST-PRIVATE-PASSWORD'), false);
    assert.equal(request.options.headers.Authorization, 'Bearer ' + PRIVATE_MARKER); assert.equal(request.options.redirect, 'error');
  }
  assert.equal(requests[1].options.headers['x-upsert'], 'false'); assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[2].url, ownerConfig.SUPABASE_URL + '/storage/v1/object/authenticated/' + AVATAR_BUCKET + '/' + key);
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), { prefixes: [key] });
  await assert.rejects(createPrivateStorage(ownerConfig, async () => Response.json({ id: AVATAR_BUCKET, public: true })).assertPrivate(), /must be private/);
  await assert.rejects(createPrivateStorage(ownerConfig, async () => new Response(PRIVATE_MARKER, { status: 409 })).upload(key, bytes, 'image/png'), error => /overwrite refused/.test(error.message) && !error.message.includes(PRIVATE_MARKER));
  await assert.rejects(createPrivateStorage(ownerConfig, async () => { throw new Error(PRIVATE_MARKER); }).assertPrivate(), error => !error.message.includes(PRIVATE_MARKER));
});

test('lost upload acknowledgement leaves an unknown private object, and retry safely reuses it without overwrite', async t => {
  const f = await fixture(t, snapshotFixture(true)), database = await sqliteTarget(t), objects = new Map(); let uploads = 0;
  const storage = createPrivateStorage(ownerConfig, async (url, options) => {
    if (url.includes('/bucket/')) return Response.json({ id: AVATAR_BUCKET, public: false });
    const key = decodeURI(url.split('/' + AVATAR_BUCKET + '/')[1] || '');
    if (options.method === 'POST') {
      if (objects.has(key)) return Response.json({ statusCode: '409', error: 'Duplicate' }, { status: 400 });
      objects.set(key, Buffer.from(options.body));
      if (++uploads === 2) throw new Error(PRIVATE_MARKER);
      return Response.json({});
    }
    if (options.method === 'DELETE') { for (const key of JSON.parse(options.body).prefixes) objects.delete(key); return Response.json({}); }
    return new Response(objects.get(key), { headers: { 'Content-Type': 'image/png' } });
  });
  await assert.rejects(importSupabaseBackup(f.options, { database, storage }), error => error.storageUncertain && /owner inspection/.test(error.message) && !error.message.includes(PRIVATE_MARKER));
  assertEmpty(database); assert.deepEqual([...objects.keys()], f.snapshot.avatars.map(avatar => avatar.key));
  const receipt = await importSupabaseBackup(f.options, { database, storage });
  assert.equal(receipt.avatarCount, 2); assert.equal(objects.size, 2);
  for (const avatar of f.snapshot.avatars) assert.equal(sha256(objects.get(avatar.key)), avatar.sha256);
});

test('CLI accepts no secret argument and prints neither malformed snapshot values nor owner credentials', async t => {
  const f = await fixture(t);
  const arguments_ = ['--snapshot', f.options.snapshotPath, '--migration-id', f.options.migrationId, '--from-api-origin', f.options.fromApiOrigin, '--to-api-origin', f.options.toApiOrigin, '--page-base-url', f.options.pageBaseUrl, '--config', f.configFile];
  const invoke = async args => { const result = { stdout: '', stderr: '' }; result.status = await runSupabaseImportCli(args, { stdout: { write: text => { result.stdout += text; } }, stderr: { write: text => { result.stderr += text; } } }); return result; };
  await writeFile(f.options.snapshotPath, '{"private-record":"' + PRIVATE_MARKER + '" INVALID', { mode: 0o600 });
  for (const args of [arguments_, ['--owner-db-url', ownerConfig.OWNER_DB_URL], ['--service-role-key', PRIVATE_MARKER], ['--config', f.configFile, '--config-stdin']]) {
    const failure = await invoke(args); assert.equal(failure.status, 1);
    assert.equal((failure.stdout + failure.stderr).includes(PRIVATE_MARKER), false); assert.equal((failure.stdout + failure.stderr).includes('TEST-PRIVATE-PASSWORD'), false); assert.equal(failure.stdout, '');
  }
});

test('isolated PostgreSQL imports and reads back exact originals, refuses nonempty targets, enforces private grants, and atomically rolls back a receipt failure', { skip: !process.env.TENNIS_TEST_PG_URL }, async t => {
  const testUrl = new URL(process.env.TENNIS_TEST_PG_URL);
  assert.equal(['localhost', '127.0.0.1', '[::1]'].includes(testUrl.hostname), true, 'Integration fixtures require a loopback-only PostgreSQL target.');
  const postgres = (await import('postgres')).default;
  const admin = postgres(testUrl.href, { max: 1, ssl: false, onnotice() {}, debug: false });
  const databases = [], connections = [];
  t.after(async () => {
    for (const database of connections) await database.close();
    for (const name of databases) await admin.unsafe('DROP DATABASE "' + name + '" WITH (FORCE)');
    await admin.end();
  });
  await admin.unsafe("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END $$");
  const schema = await readFile(new URL('../supabase/migrations/20261004000000_tennis_schema.sql', import.meta.url), 'utf8');
  async function freshTarget() {
    const name = 'tennis_import_' + randomUUID().replaceAll('-', ''); databases.push(name); await admin.unsafe('CREATE DATABASE "' + name + '"');
    const url = new URL(testUrl); url.pathname = '/' + name;
    const sql = postgres(url.href, { max: 1, ssl: false, onnotice() {}, debug: false });
    await sql.unsafe('CREATE SCHEMA storage; CREATE TABLE storage.buckets (id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[])');
    await sql.unsafe(schema);
    const database = await createOwnerDatabase({ ...ownerConfig, OWNER_DB_URL: url.href }); connections.push(database);
    connections.push({ close: () => sql.end() });
    assert.equal((await sql.unsafe('SELECT public FROM storage.buckets WHERE id=$1', [AVATAR_BUCKET]))[0].public, false);
    return { database, sql, config: { ...ownerConfig, OWNER_DB_URL: url.href } };
  }
  const f = await fixture(t, snapshotFixture(true)), target = await freshTarget(), storage = memoryStorage();
  const receipt = await importSupabaseBackup({ ...f.options, config: target.config }, { database: target.database, storage });
  for (const table of TABLE_NAMES) assert.deepEqual((await target.database.readRows(table)).map(canonicalStringify).sort(), f.snapshot.tables[table].map(canonicalStringify).sort());
  assert.deepEqual((await target.sql.unsafe('SELECT metadata FROM public.tennis_migration_receipt'))[0].metadata, receipt);
  const beforeRequests = storage.events.length;
  await assert.rejects(importSupabaseBackup({ ...f.options, config: target.config }, { database: target.database, storage }), /target contains/);
  assert.equal(storage.events.length, beforeRequests);
  const failed = await freshTarget(), failedStorage = memoryStorage();
  await failed.sql.unsafe('GRANT SELECT ON public.accounts TO anon');
  await assert.rejects(importSupabaseBackup({ ...f.options, config: failed.config }, { database: failed.database, storage: failedStorage }), /browser roles/);
  assert.equal(failedStorage.events.length, 0); await failed.sql.unsafe('REVOKE SELECT ON public.accounts FROM anon');
  await failed.sql.unsafe("CREATE FUNCTION public.reject_fixture_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic private fixture error'; END $$; CREATE TRIGGER reject_fixture_receipt BEFORE INSERT ON public.tennis_migration_receipt FOR EACH ROW EXECUTE FUNCTION public.reject_fixture_receipt()");
  await assert.rejects(importSupabaseBackup({ ...f.options, config: failed.config }, { database: failed.database, storage: failedStorage }), /transaction failed/);
  for (const table of [...TABLE_NAMES, 'tennis_migration_receipt']) assert.equal(Number((await failed.sql.unsafe('SELECT COUNT(*) AS n FROM public."' + table + '"'))[0].n), 0);
  assert.equal(failedStorage.objects.size, 2);
  assert.equal(failedStorage.events.some(event => Array.isArray(event) && event[0] === 'cleanup'), false);

  // Concurrent isolates may reuse exact staged objects. Whichever reaches
  // the short SQL transaction first wins; a later failure never deletes them.
  const concurrent = await freshTarget(), otherDatabase = await createOwnerDatabase(concurrent.config); connections.push(otherDatabase);
  const shared = memoryStorage(), baseUpload = shared.upload; let pausedOnce = false;
  let enterUpload, releaseUpload;
  const entered = new Promise(resolve => { enterUpload = resolve; }), paused = new Promise(resolve => { releaseUpload = resolve; });
  shared.upload = async (...args) => { await baseUpload(...args); if (!pausedOnce) { pausedOnce = true; enterUpload(); await paused; } };
  const firstImport = importSupabaseBackup({ ...f.options, config: concurrent.config }, { database: concurrent.database, storage: shared }).then(() => null, error => error);
  await entered;
  let winner;
  try { winner = await importSupabaseBackup({ ...f.options, config: concurrent.config }, { database: otherDatabase, storage: shared }); }
  finally { releaseUpload(); }
  assert.equal(winner.avatarCount, 2);
  assert.match((await firstImport).message, /target contains/);
  assert.equal(shared.objects.size, 2);
  assert.equal(shared.events.some(event => Array.isArray(event) && event[0] === 'cleanup'), false);
  for (const avatar of f.snapshot.avatars) assert.equal(sha256(shared.objects.get(avatar.key).bytes), avatar.sha256);
  for (const table of TABLE_NAMES) assert.deepEqual((await concurrent.database.readRows(table)).map(canonicalStringify).sort(), f.snapshot.tables[table].map(canonicalStringify).sort());

  // No late DELETE survives a failed import. A separate connection safely
  // retries the exact private objects left by a rolled-back receipt failure.
  const retryDatabase = await createOwnerDatabase(failed.config); connections.push(retryDatabase);
  await failed.sql.unsafe('DROP TRIGGER reject_fixture_receipt ON public.tennis_migration_receipt');
  assert.equal((await importSupabaseBackup({ ...f.options, config: failed.config }, { database: retryDatabase, storage: failedStorage })).avatarCount, 2);
  for (const avatar of f.snapshot.avatars) assert.equal(sha256(failedStorage.objects.get(avatar.key).bytes), avatar.sha256);
  assert.equal(failedStorage.events.some(event => Array.isArray(event) && event[0] === 'cleanup'), false);

  // Storage staging holds no transaction or reserved client. Kill only this
  // fixture's idle pool connection; resuming HTTP must safely reconnect or
  // fail without publishing, then allow an exact-object retry in this process.
  const killed = await freshTarget(), killStorage = memoryStorage(), originalUpload = killStorage.upload;
  let uploadEntered, releaseDeadUpload;
  const deadUploadEntered = new Promise(resolve => { uploadEntered = resolve; }), deadUploadPaused = new Promise(resolve => { releaseDeadUpload = resolve; });
  killStorage.upload = async (...args) => { await originalUpload(...args); uploadEntered(); await deadUploadPaused; };
  const deadImport = importSupabaseBackup({ ...f.options, config: killed.config }, { database: killed.database, storage: killStorage }).then(receipt => receipt, error => error);
  await deadUploadEntered;
  const pid = (await killed.sql.unsafe("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid <> pg_backend_pid() AND state='idle'"))[0]?.pid;
  assert.equal(Number.isInteger(pid), true);
  await killed.sql.unsafe('SELECT pg_terminate_backend($1)', [pid]);
  releaseDeadUpload();
  const resumed = await deadImport;
  if (resumed instanceof SupabaseImportError) {
    for (const table of [...TABLE_NAMES, 'tennis_migration_receipt']) assert.equal(Number((await killed.sql.unsafe('SELECT COUNT(*) AS n FROM public."' + table + '"'))[0].n), 0);
    const replacement = await createOwnerDatabase(killed.config); connections.push(replacement);
    assert.equal((await importSupabaseBackup({ ...f.options, config: killed.config }, { database: replacement, storage: killStorage })).avatarCount, 2);
  } else assert.equal(resumed.avatarCount, 2);
  assert.equal(killStorage.events.some(event => Array.isArray(event) && event[0] === 'cleanup'), false);
  for (const table of TABLE_NAMES) assert.deepEqual((await killed.database.readRows(table)).map(canonicalStringify).sort(), f.snapshot.tables[table].map(canonicalStringify).sort());
  for (const avatar of f.snapshot.avatars) assert.equal(sha256(killStorage.objects.get(avatar.key).bytes), avatar.sha256);
});
