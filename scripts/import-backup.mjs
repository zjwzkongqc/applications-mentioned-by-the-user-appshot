import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, createBucket } from '../server/storage.mjs';
import { APP_ID, FORMAT_VERSION, SCHEMA_VERSION, TABLE_NAMES, TABLE_COLUMNS, BackupValidationError, canonicalStringify, sha256, validateBackup, validateOrigin, validatePageBaseUrl } from './backup-format.mjs';

const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle/', import.meta.url));
const SOURCE_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const DATABASE_NAME = 'tennis.sqlite';
const RECEIPT_NAME = 'migration-receipt.json';
export class BackupImportError extends Error {
  constructor(message) { super(message); this.name = 'BackupImportError'; }
}
const refuse = message => { throw new BackupImportError(message); };
async function syncDirectory(directory) { const file = await open(directory, constants.O_RDONLY); try { await file.sync(); } finally { await file.close(); } }
async function privateWrite(filename, contents) {
  const file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
}
async function migrations() {
  const names = (await readdir(MIGRATIONS_DIR)).filter(name => /^\d{4}_[\w-]+\.sql$/.test(name)).sort();
  if (names.length !== SCHEMA_VERSION + 1 || names.some((name, index) => Number(name.slice(0, 4)) !== index)) refuse('The importer requires all unchanged application schema migrations.');
  return new Map(await Promise.all(names.map(async name => [name, sha256(await readFile(path.join(MIGRATIONS_DIR, name)))])));
}
async function existingInfo(filename) {
  try { return await lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function emptyTarget(directory, expectedMigrations) {
  const info = await existingInfo(directory);
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink()) refuse('The target must be an unused regular data directory.');
  const allowed = new Set([DATABASE_NAME, DATABASE_NAME + '-wal', DATABASE_NAME + '-shm', 'avatars']);
  const names = await readdir(directory);
  if (names.some(name => !allowed.has(name))) refuse('The target contains files other than an unused migration database.');
  for (const name of names) {
    const entry = await lstat(path.join(directory, name));
    if (entry.isSymbolicLink() || (name === 'avatars' ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1)) refuse('The target contains unsafe storage entries.');
    if (name === 'avatars' && (await readdir(path.join(directory, name))).length) refuse('The target already contains avatar objects.');
  }
  if (names.includes(DATABASE_NAME)) {
    let database, inspection;
    try {
      // WAL-mode SQLite can change sidecars even on a read-only connection.
      // Inspect private copies so this check never changes the original target.
      inspection = await mkdtemp(path.join(path.dirname(directory), '.tennis-target-check-'));
      await chmod(inspection, 0o700);
      for (const name of names.filter(name => name.startsWith(DATABASE_NAME))) {
        const source = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await privateWrite(path.join(inspection, name), await source.readFile()); } finally { await source.close(); }
      }
      database = new DatabaseSync(path.join(inspection, DATABASE_NAME), { readOnly: true });
      const objects = database.prepare("SELECT name,type FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%'").all();
      if (objects.some(row => row.type !== 'table' || (!TABLE_NAMES.includes(row.name) && row.name !== '_tennis_migrations'))) refuse('The target contains an unrelated database schema.');
      for (const { name } of objects) {
        if (TABLE_NAMES.includes(name) && database.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n !== 0) refuse('The target already contains application data; import refused.');
        if (name === '_tennis_migrations') for (const row of database.prepare('SELECT name,sha256 FROM _tennis_migrations').all()) {
          if (expectedMigrations.get(row.name) !== row.sha256) refuse('The target migration journal does not match this application.');
        }
      }
    } catch (error) {
      if (error instanceof BackupImportError) throw error;
      refuse('The target is not a readable unused tennis database.');
    } finally { database?.close(); if (inspection) await rm(inspection, { recursive: true, force: true }); }
  } else if (names.some(name => name.startsWith(DATABASE_NAME))) refuse('The target has database sidecars without their database.');
  // Compare again immediately before publication to refuse a changed target.
  const state = [];
  for (const name of (await readdir(directory)).sort()) {
    const filename = path.join(directory, name), entry = await lstat(filename, { bigint: true });
    state.push([name, String(entry.dev), String(entry.ino), String(entry.size), String(entry.mtimeNs), name === 'avatars' ? null : sha256(await readFile(filename))]);
  }
  return canonicalStringify({ dev: info.dev, ino: info.ino, state });
}
function trustedOptions(options) {
  if (!options || typeof options.snapshotPath !== 'string' || !options.snapshotPath || typeof options.dataDir !== 'string' || !options.dataDir) refuse('Explicit snapshot and target paths are required.');
  if (typeof options.migrationId !== 'string' || !/^[a-f0-9]{64}$/.test(options.migrationId)) refuse('An explicit 64-character lowercase hexadecimal migration identifier is required.');
  validateOrigin(options.fromApiOrigin, 'fromApiOrigin'); validateOrigin(options.toApiOrigin, 'toApiOrigin'); validatePageBaseUrl(options.pageBaseUrl);
  return options;
}
async function readSnapshot(filename) {
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n || (Number(info.mode) & 0o777) !== 0o600) refuse('The snapshot must be a single-link regular private JSON file with mode 0600.');
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink'].some(field => info[field] !== after[field]) || after.size !== BigInt(bytes.length)) refuse('The private snapshot changed while it was being read.');
    let snapshot;
    try { snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { refuse('The snapshot is not valid UTF-8 JSON.'); }
    return { bytes, ...validateBackup(snapshot) };
  } catch (error) {
    if (error instanceof BackupImportError || error instanceof BackupValidationError) throw error;
    refuse('The private snapshot could not be read.');
  } finally { await file?.close(); }
}
async function verifyImported(database, validated) {
  if ((await database.prepare('PRAGMA foreign_key_check').all()).results.length) refuse('The staged database contains broken relationships.');
  if ((await database.prepare('PRAGMA quick_check').all()).results.some(row => Object.values(row)[0] !== 'ok')) refuse('The staged database failed integrity verification.');
  for (const table of TABLE_NAMES) {
    const rows = (await database.prepare(`SELECT ${TABLE_COLUMNS[table].map(column => '"' + column + '"').join(',')} FROM "${table}"`).all()).results;
    const expected = validated.snapshot.tables[table].map(canonicalStringify).sort();
    const actual = rows.map(canonicalStringify).sort();
    if (expected.length !== actual.length || expected.some((row, index) => row !== actual[index])) refuse('The staged database does not exactly preserve the snapshot rows.');
  }
}

/** Offline-only: stop the Node service before importing or replacing DATA_DIR.
 * No network or environment-derived metadata is used. Test dependencies can
 * inject storage failures without touching production data.
 */
export async function importBackup(options, dependencies = {}) {
  trustedOptions(options);
  const validated = await readSnapshot(path.resolve(options.snapshotPath));
  if (validated.snapshot.fromApiOrigin !== options.fromApiOrigin) refuse('The explicit source origin does not match the snapshot.');
  const expectedMigrations = await migrations();
  const requested = path.resolve(options.dataDir), basename = path.basename(requested);
  if (!basename || requested === path.dirname(requested)) refuse('A dedicated target data directory is required.');
  const within = (parent, child) => { const relative = path.relative(parent, child); return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
  const separate = directory => { if (within(SOURCE_ROOT, directory) || within(directory, SOURCE_ROOT)) refuse('The target must be outside and separate from the source checkout.'); };
  separate(requested);
  await mkdir(path.dirname(requested), { recursive: true, mode: 0o700 });
  const parent = await realpath(path.dirname(requested)), target = path.join(parent, basename);
  separate(target);
  const lockPath = path.join(parent, '.' + basename + '.migration-import.lock');
  let lock, stage, parked, database, published = false;
  try {
    try { lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch { refuse('Another import is active or the private import lock is unavailable.'); }
    const original = await emptyTarget(target, expectedMigrations);
    stage = await mkdtemp(path.join(parent, '.tennis-import-')); await chmod(stage, 0o700);
    const databaseFactory = dependencies.createDatabase || createDatabase, bucketFactory = dependencies.createBucket || createBucket;
    database = databaseFactory({ filename: path.join(stage, DATABASE_NAME), migrationsDir: MIGRATIONS_DIR });
    const bucket = await bucketFactory({ directory: path.join(stage, 'avatars') });
    const statements = [];
    for (const table of TABLE_NAMES) {
      const columns = TABLE_COLUMNS[table], sql = `INSERT INTO "${table}" (${columns.map(column => '"' + column + '"').join(',')}) VALUES(${columns.map(() => '?').join(',')})`;
      for (const row of validated.snapshot.tables[table]) statements.push(database.prepare(sql).bind(...columns.map(column => row[column])));
    }
    // One transaction contains all application rows, without upsert or coercion.
    await database.batch(statements);
    await verifyImported(database, validated);
    for (const avatar of validated.avatars.values()) {
      await bucket.put(avatar.key, avatar.bytes, { httpMetadata: { contentType: avatar.contentType } });
      const restored = await bucket.get(avatar.key);
      if (!restored || restored.httpMetadata?.contentType !== avatar.contentType || restored.size !== avatar.bytes.length || sha256(Buffer.from(await new Response(restored.body).arrayBuffer())) !== avatar.sha256) refuse('The staged avatar failed full object verification.');
    }
    await database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all(); database.close(); database = null;
    await chmod(path.join(stage, DATABASE_NAME), 0o600);
    const dbFile = await open(path.join(stage, DATABASE_NAME), constants.O_RDONLY); try { await dbFile.sync(); } finally { await dbFile.close(); }
    const receipt = {
      formatVersion: FORMAT_VERSION, appId: APP_ID, schemaVersion: SCHEMA_VERSION,
      migrationId: options.migrationId, fromApiOrigin: options.fromApiOrigin, toApiOrigin: options.toApiOrigin, pageBaseUrl: options.pageBaseUrl,
      credentialsPreserved: true, sourceSnapshotSha256: sha256(validated.bytes), importedAt: new Date().toISOString(),
      tableCounts: validated.tableCounts, avatarCount: validated.avatarCount
    };
    await privateWrite(path.join(stage, RECEIPT_NAME), JSON.stringify(receipt, null, 2) + '\n');
    await syncDirectory(path.join(stage, 'avatars')); await syncDirectory(stage);
    if (await emptyTarget(target, expectedMigrations) !== original) refuse('The target changed during import; publication refused.');
    if (original !== null) {
      parked = await mkdtemp(path.join(parent, '.tennis-empty-target-'));
      await rm(parked, { recursive: true });
      await rename(target, parked);
    }
    await rename(stage, target); published = true;
    await syncDirectory(parent);
    stage = null;
    // Publication is durable at this point. A leftover empty predecessor must
    // not turn a completed import into a reported partial failure.
    if (parked) { await rm(parked, { recursive: true, force: true }).catch(() => {}); parked = null; }
    return receipt;
  } catch (error) {
    database?.close(); database = null;
    if (published && stage) { await rename(target, stage); published = false; }
    if (parked) { await rename(parked, target); parked = null; }
    if (error instanceof BackupImportError || error instanceof BackupValidationError) throw error;
    refuse('Import failed; the original target was left unchanged.');
  } finally {
    if (database) database.close();
    if (stage) await rm(stage, { recursive: true, force: true });
    if (lock) { await lock.close(); await unlink(lockPath); }
  }
}

const HELP = [
  'Offline tennis backup import (stop the Node service first).',
  '',
  'node scripts/import-backup.mjs --snapshot /private/backup.json --data-dir /private/new-data --migration-id ' + 'a'.repeat(64) + ' --from-api-origin https://old.example --to-api-origin https://new.example --page-base-url https://owner.github.io/app/',
  '',
  'Use a fresh random migration identifier. Only an absent or unused migration-only target outside the source checkout is accepted. Snapshot contents are never printed.'
].join('\n') + '\n';
function parseCli(arguments_) {
  const fields = new Map([['--snapshot', 'snapshotPath'], ['--data-dir', 'dataDir'], ['--migration-id', 'migrationId'], ['--from-api-origin', 'fromApiOrigin'], ['--to-api-origin', 'toApiOrigin'], ['--page-base-url', 'pageBaseUrl']]);
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = fields.get(arguments_[index]);
    if (!name || Object.hasOwn(options, name) || typeof arguments_[index + 1] !== 'string' || arguments_[index + 1].startsWith('--')) refuse('Invalid, duplicate, or incomplete command-line options.');
    options[name] = arguments_[index + 1];
  }
  return options;
}
export async function runImportCli(arguments_, output = { stdout: process.stdout, stderr: process.stderr }) {
  if (arguments_.length === 1 && arguments_[0] === '--help') { output.stdout.write(HELP); return 0; }
  else {
    try { await importBackup(parseCli(arguments_)); output.stdout.write('Import completed.\n'); return 0; }
    catch (error) {
      output.stderr.write((error instanceof BackupImportError || error instanceof BackupValidationError ? error.message : 'Import failed without publishing a snapshot.') + '\n');
      return 1;
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runImportCli(process.argv.slice(2));
