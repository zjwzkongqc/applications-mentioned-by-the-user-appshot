import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, symlink, chmod, link, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, createBucket } from '../server/storage.mjs';
import { APP_ID, TABLE_NAMES, TABLE_COLUMNS, sha256, canonicalStringify, snapshotChecksum, validateBackup } from '../scripts/backup-format.mjs';
import { importBackup, runImportCli } from '../scripts/import-backup.mjs';

const migrationsDir = fileURLToPath(new URL('../drizzle/', import.meta.url));
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const time = '2026-10-04T10:00:00.000Z';
const longText = '这是完整历史，包含换行和球友感想。\n🎾'.repeat(4000);
function snapshotFixture() {
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
  return { formatVersion: 1, appId: APP_ID, schemaVersion: 4, createdAt: time, fromApiOrigin: 'https://old.example', tables, avatars: [{ key: avatarKey, contentType: 'image/png', dataBase64: bytes.toString('base64'), sha256: sha256(bytes) }] };
}
async function fixture(t, snapshot = snapshotFixture()) {
  const root = await mkdtemp(path.join(tmpdir(), 'tennis-migration-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshotPath = path.join(root, 'private-snapshot.json'), dataDir = path.join(root, 'new-data');
  await writeFile(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 });
  const options = { snapshotPath, dataDir, migrationId: '12'.repeat(32), fromApiOrigin: 'https://old.example', toApiOrigin: 'https://new.example', pageBaseUrl: 'https://owner.github.io/tennis/' };
  return { root, snapshot, options, rewrite: value => writeFile(snapshotPath, JSON.stringify(value), { mode: 0o600 }) };
}
async function assertNoStage(root) { assert.equal((await readdir(root)).some(name => name.startsWith('.tennis-') || name.endsWith('.migration-import.lock')), false); }
async function emptyDatabase(options) {
  await mkdir(options.dataDir, { mode: 0o700 });
  const database = createDatabase({ filename: path.join(options.dataDir, 'tennis.sqlite'), migrationsDir });
  database.close();
  return sha256(await readFile(path.join(options.dataDir, 'tennis.sqlite')));
}

test('all eleven tables, full historical text, credential hashes, expiry, and avatar bytes are preserved', async t => {
  const f = await fixture(t); f.snapshot.checksum = snapshotChecksum(f.snapshot); await f.rewrite(f.snapshot);
  const receipt = await importBackup(f.options);
  assert.equal(receipt.sourceSnapshotSha256, sha256(await readFile(f.options.snapshotPath)));
  assert.deepEqual(Object.keys(receipt).sort(), ['formatVersion', 'appId', 'schemaVersion', 'migrationId', 'fromApiOrigin', 'toApiOrigin', 'pageBaseUrl', 'credentialsPreserved', 'sourceSnapshotSha256', 'importedAt', 'tableCounts', 'avatarCount'].sort());
  assert.equal(receipt.credentialsPreserved, true); assert.equal(receipt.avatarCount, 1);
  assert.deepEqual(receipt.tableCounts, Object.fromEntries(TABLE_NAMES.map(table => [table, 1])));
  assert.deepEqual(JSON.parse(await readFile(path.join(f.options.dataDir, 'migration-receipt.json'), 'utf8')), receipt);
  const sqlite = new DatabaseSync(path.join(f.options.dataDir, 'tennis.sqlite'), { readOnly: true });
  try {
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM _tennis_migrations').get().n, 5);
    for (const table of TABLE_NAMES) assert.equal(canonicalStringify({ ...sqlite.prepare(`SELECT ${TABLE_COLUMNS[table].join(',')} FROM ${table}`).get() }), canonicalStringify(f.snapshot.tables[table][0]));
    assert.equal(sqlite.prepare('SELECT note FROM records').get().note, longText);
    assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { sqlite.close(); }
  const bucket = await createBucket({ directory: path.join(f.options.dataDir, 'avatars') }), avatar = f.snapshot.avatars[0], restored = await bucket.get(avatar.key);
  assert.equal(restored.httpMetadata.contentType, avatar.contentType);
  assert.equal(sha256(Buffer.from(await new Response(restored.body).arrayBuffer())), avatar.sha256);
  assert.deepEqual(await readdir(path.join(f.options.dataDir, 'avatars')), [sha256(avatar.key) + '.object']);
  assert.equal((await stat(f.options.dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(f.options.dataDir, 'avatars'))).mode & 0o777, 0o700);
  for (const filename of ['tennis.sqlite', 'migration-receipt.json', 'avatars/' + sha256(avatar.key) + '.object']) assert.equal((await stat(path.join(f.options.dataDir, filename))).mode & 0o777, 0o600);
  await assertNoStage(f.root);
});

test('strict format, columns, types, checksums, duplicates, and relations are rejected before publication', async t => {
  const invalid = [
    value => { value.schemaVersion = 3; }, value => { value.appId = 'another-app'; }, value => { value.tables.extra = []; },
    value => { delete value.tables.cheers; }, value => { value.tables.members[0].unknown = 'private secret'; },
    value => { delete value.tables.records[0].next_plan; }, value => { value.tables.account_sessions[0].expires_at = '1791108000000'; },
    value => { value.tables.accounts[0].recovery_hash = 'not-a-hash'; }, value => { value.tables.clubs[0].owner_id = id(999); },
    value => { value.tables.members[0].account_id = id(999); }, value => { value.tables.account_sessions.push({ ...value.tables.account_sessions[0] }); },
    value => { value.tables.members.push({ ...value.tables.members[0], id: id(99) }); },
    value => { value.tables.club_invites[0].invite_hash = value.tables.clubs[0].invite_hash; },
    value => { value.tables.records[0].club_id = id(99); }, value => { value.tables.cheers[0].record_id = id(99); },
    value => { value.tables.auth_registrations[0].legacy_hash = '8'.repeat(64); },
    value => { value.tables.records[0].forehand = null; }, value => { value.tables.records[0].training_projects = '["backhand","backhand"]'; },
    value => { value.checksum = '9'.repeat(64); }, value => { value.avatars = []; },
    value => { value.avatars[0].sha256 = '9'.repeat(64); }, value => { value.avatars[0].dataBase64 += '!'; },
    value => { value.avatars[0].contentType = 'image/jpeg'; }, value => { value.avatars.push({ ...value.avatars[0] }); },
    value => { value.avatars[0].key = '../outside'; }, value => { value.tables.records[0].note = '\ud800'; }
  ];
  for (const mutate of invalid) {
    const snapshot = snapshotFixture(); mutate(snapshot);
    assert.throws(() => validateBackup(snapshot), { name: 'BackupValidationError' });
  }
  const f = await fixture(t); const snapshot = snapshotFixture(); snapshot.avatars = []; await f.rewrite(snapshot);
  await assert.rejects(importBackup(f.options), /missing referenced avatar/);
  assert.equal((await readdir(f.root)).includes('new-data'), false); await assertNoStage(f.root);
});

test('existing empty migrations are replaceable; nonempty business data and objects are not', async t => {
  const f = await fixture(t); await emptyDatabase(f.options); await importBackup(f.options);
  assert.equal(JSON.parse(await readFile(path.join(f.options.dataDir, 'migration-receipt.json'), 'utf8')).credentialsPreserved, true);
  const nonempty = await fixture(t); await emptyDatabase(nonempty.options);
  const filename = path.join(nonempty.options.dataDir, 'tennis.sqlite'), database = new DatabaseSync(filename);
  database.prepare('INSERT INTO clubs(id,invite_hash,name,slogan,owner_id,created_at) VALUES(?,?,?,?,?,?)').run(id(50), '1'.repeat(64), 'do not replace', '', id(51), time); database.close();
  const before = sha256(await readFile(filename));
  await assert.rejects(importBackup(nonempty.options), /already contains application data/);
  assert.equal(sha256(await readFile(filename)), before); assert.equal((await readdir(nonempty.options.dataDir)).includes('migration-receipt.json'), false); await assertNoStage(nonempty.root);
  const orphan = await fixture(t); await mkdir(path.join(orphan.options.dataDir, 'avatars'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(orphan.options.dataDir, 'avatars', 'keep.object'), 'keep', { mode: 0o600 });
  await assert.rejects(importBackup(orphan.options), /already contains avatar/);
  assert.equal(await readFile(path.join(orphan.options.dataDir, 'avatars', 'keep.object'), 'utf8'), 'keep'); await assertNoStage(orphan.root);
});

test('avatar staging failure leaves absent and existing empty targets untouched and cleans staging', async t => {
  for (const existing of [false, true]) {
    const f = await fixture(t), before = existing ? await emptyDatabase(f.options) : null;
    await assert.rejects(importBackup(f.options, { createBucket: async options => {
      const bucket = await createBucket(options);
      return { ...bucket, async put(...arguments_) { await bucket.put(...arguments_); throw new Error('Injected object write failure'); } };
    } }), /original target was left unchanged/);
    if (existing) assert.equal(sha256(await readFile(path.join(f.options.dataDir, 'tennis.sqlite'))), before);
    else assert.equal((await readdir(f.root)).includes('new-data'), false);
    await assertNoStage(f.root);
  }
});

test('a last-table SQL failure rolls back every imported table and preserves the original target', async t => {
  const f = await fixture(t), before = await emptyDatabase(f.options); let rolledBack;
  await assert.rejects(importBackup(f.options, { createDatabase: options => {
    const database = createDatabase(options);
    database.prepare("CREATE TRIGGER fixture_fail BEFORE INSERT ON checkins BEGIN SELECT RAISE(ABORT,'fixture failure'); END").run();
    const close = database.close;
    database.close = () => {
      // Storage executes synchronously, so the transaction has already rolled
      // back when importBackup closes the failed staged database.
      const inspection = new DatabaseSync(options.filename, { readOnly: true });
      rolledBack = TABLE_NAMES.map(table => inspection.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
      inspection.close(); close();
    };
    return database;
  } }), /original target was left unchanged/);
  assert.deepEqual(rolledBack, TABLE_NAMES.map(() => 0));
  assert.equal(sha256(await readFile(path.join(f.options.dataDir, 'tennis.sqlite'))), before); await assertNoStage(f.root);
});

test('snapshot and target symlinks are refused, and missing explicit metadata never uses environment values', async t => {
  const f = await fixture(t), snapshotLink = path.join(f.root, 'link.json'); await symlink(f.options.snapshotPath, snapshotLink);
  await assert.rejects(importBackup({ ...f.options, snapshotPath: snapshotLink }), /could not be read/);
  const outside = path.join(f.root, 'outside'); await mkdir(outside); await symlink(outside, f.options.dataDir);
  await assert.rejects(importBackup(f.options), /unused regular data directory/);
  assert.deepEqual(await readdir(outside), []); await assertNoStage(f.root);
  const incomplete = { ...f.options }; delete incomplete.toApiOrigin;
  await assert.rejects(importBackup(incomplete), /explicit HTTP origin/);
});

test('CLI receipts use explicit trusted origins and errors never print snapshot contents', async t => {
  const f = await fixture(t);
  const arguments_ = ['--snapshot', f.options.snapshotPath, '--data-dir', f.options.dataDir, '--migration-id', f.options.migrationId, '--from-api-origin', f.options.fromApiOrigin, '--to-api-origin', f.options.toApiOrigin, '--page-base-url', f.options.pageBaseUrl];
  const invoke = async arguments_ => { const result = { stdout: '', stderr: '' }; result.status = await runImportCli(arguments_, { stdout: { write: text => { result.stdout += text; } }, stderr: { write: text => { result.stderr += text; } } }); return result; };
  const success = await invoke(arguments_);
  assert.equal(success.status, 0); assert.equal(success.stdout, 'Import completed.\n'); assert.equal(success.stdout.includes('原球友'), false);
  const receipt = JSON.parse(await readFile(path.join(f.options.dataDir, 'migration-receipt.json'), 'utf8'));
  for (const field of ['migrationId', 'fromApiOrigin', 'toApiOrigin', 'pageBaseUrl']) assert.equal(receipt[field], f.options[field]);
  const malformed = await fixture(t); await writeFile(malformed.options.snapshotPath, '{"very-private-credential": THIS-SECRET-MUST-NEVER-PRINT', { mode: 0o600 });
  const failure = await invoke(arguments_.map(value => value === f.options.snapshotPath ? malformed.options.snapshotPath : value === f.options.dataDir ? malformed.options.dataDir : value));
  assert.equal(failure.status, 1); assert.match(failure.stderr, /not valid UTF-8 JSON/); assert.equal((failure.stdout + failure.stderr).includes('THIS-SECRET'), false);
  const wrongSource = await fixture(t);
  await assert.rejects(importBackup({ ...wrongSource.options, fromApiOrigin: 'https://forged.example' }), /does not match/);
  assert.equal((await readdir(wrongSource.root)).includes('new-data'), false);
});

test('private snapshot permissions, hard links, source checkout targets, and incompatible migration IDs are refused', async t => {
  const f = await fixture(t);
  await chmod(f.options.snapshotPath, 0o644);
  await assert.rejects(importBackup(f.options), /mode 0600/);
  await chmod(f.options.snapshotPath, 0o600);
  const linked = path.join(f.root, 'second-link.json'); await link(f.options.snapshotPath, linked);
  await assert.rejects(importBackup(f.options), /single-link/); await unlink(linked);
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  for (const dataDir of [path.join(sourceRoot, 'must-not-create-migration-data'), path.dirname(sourceRoot.replace(/\/$/, ''))]) {
    await assert.rejects(importBackup({ ...f.options, dataDir }), /outside and separate from the source checkout/);
  }
  const alias = path.join(f.root, 'source-alias'); await symlink(sourceRoot, alias);
  await assert.rejects(importBackup({ ...f.options, dataDir: path.join(alias, 'must-not-create-migration-data') }), /outside and separate from the source checkout/);
  await assert.rejects(stat(path.join(sourceRoot, 'must-not-create-migration-data')), { code: 'ENOENT' });
  for (const migrationId of ['migration-2026', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) await assert.rejects(importBackup({ ...f.options, migrationId }), /64-character lowercase hexadecimal/);
  await assertNoStage(f.root);
});
