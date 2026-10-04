import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { constants, chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

const OBJECT_LIMIT = 2 * 1024 * 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');

class SQLiteStatement {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values) { return new SQLiteStatement(this.database, this.sql, values); }
  execute(operation) {
    const statement = this.database.prepare(this.sql);
    if (operation === 'first') {
      const row = statement.get(...this.values);
      return row ? { ...row } : null;
    }
    if (operation === 'all') return { results: statement.all(...this.values).map(row => ({ ...row })), success: true };
    const result = statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
  async first(column) { const row = this.execute('first'); return column === undefined ? row : row?.[column] ?? null; }
  async all() { return this.execute('all'); }
  async run() { return this.execute('run'); }
}

function applyMigrations(sqlite, directory) {
  sqlite.exec('CREATE TABLE IF NOT EXISTS _tennis_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const name of readdirSync(directory).filter(name => /^\d{4}_[\w-]+\.sql$/.test(name)).sort()) {
    const sql = readFileSync(path.join(directory, name), 'utf8'), checksum = sha256(sql);
    const applied = sqlite.prepare('SELECT sha256 FROM _tennis_migrations WHERE name=?').get(name);
    if (applied) {
      if (applied.sha256 !== checksum) throw new Error('An applied database migration has changed.');
      continue;
    }
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      sqlite.exec(sql);
      sqlite.prepare('INSERT INTO _tennis_migrations(name,sha256,applied_at) VALUES(?,?,?)').run(name, checksum, new Date().toISOString());
      sqlite.exec('COMMIT');
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }
}

export function createDatabase({ filename, migrationsDir }) {
  if (!filename || !migrationsDir) throw new TypeError('Database filename and migrations directory are required.');
  const requested = path.resolve(filename);
  mkdirSync(path.dirname(requested), { recursive: true, mode: 0o700 });
  if (existsSync(requested)) {
    if (!lstatSync(requested).isFile() || lstatSync(requested).isSymbolicLink()) throw new Error('The database must be a regular private file.');
    chmodSync(requested, 0o600);
  } else closeSync(openSync(requested, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
  const resolved = path.join(realpathSync(path.dirname(requested)), path.basename(requested));
  const sqlite = new DatabaseSync(resolved);
  try {
    sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    applyMigrations(sqlite, path.resolve(migrationsDir));
  } catch (error) { sqlite.close(); throw error; }
  return {
    prepare(sql) { return new SQLiteStatement(sqlite, sql); },
    async batch(statements) {
      if (!Array.isArray(statements) || statements.some(statement => !(statement instanceof SQLiteStatement) || statement.database !== sqlite)) throw new TypeError('Batch statements must belong to this database.');
      // All SQLite operations remain synchronous within the transaction. No
      // promise can yield midway and interleave another request's transaction.
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(statement => statement.execute('run'));
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    close() { sqlite.close(); }
  };
}

function objectKey(key) {
  if (typeof key !== 'string' || !key || key.length > 1024 || key.startsWith('/') || key.includes('\\') || key.includes('\0') || key.split('/').some(segment => !segment || segment === '.' || segment === '..')) throw new TypeError('Invalid object key.');
  return sha256(key) + '.object';
}

function contentType(value = 'application/octet-stream') {
  if (typeof value !== 'string' || value.length > 200 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[^\r\n]*)?$/i.test(value)) throw new TypeError('Invalid object content type.');
  return value;
}

export async function createBucket({ directory }) {
  if (!directory) throw new TypeError('A private object directory is required.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Object storage must be a private directory.');
  const root = await realpath(directory);
  await chmod(root, 0o700);
  const syncDirectory = async () => { const handle = await open(root, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } };
  return {
    async put(key, value, options = {}) {
      const target = path.join(root, objectKey(key));
      const bytes = value instanceof ArrayBuffer ? Buffer.from(value) : ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : value instanceof Blob ? Buffer.from(await value.arrayBuffer()) : null;
      if (!bytes || bytes.length > OBJECT_LIMIT) throw new TypeError('Object body must be at most 2 MiB of binary data.');
      const metadata = Buffer.from(JSON.stringify({ version: 1, size: bytes.length, contentType: contentType(options.httpMetadata?.contentType) }));
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(metadata.length);
      const temporary = path.join(root, randomUUID() + '.tmp');
      let file;
      try {
        file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await file.writeFile(Buffer.concat([prefix, metadata, bytes]));
        await file.sync(); await file.close(); file = null;
        await rename(temporary, target);
        await syncDirectory();
      } catch (error) {
        if (file) await file.close().catch(() => {});
        await unlink(temporary).catch(() => {});
        throw error;
      }
    },
    async get(key) {
      const target = path.join(root, objectKey(key));
      let file;
      try { file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      try {
        const prefix = Buffer.alloc(4);
        if ((await file.read(prefix, 0, 4, 0)).bytesRead !== 4) throw new Error('Invalid object storage header.');
        const length = prefix.readUInt32BE();
        if (length < 2 || length > 1024) throw new Error('Invalid object storage metadata.');
        const metadata = Buffer.alloc(length);
        if ((await file.read(metadata, 0, length, 4)).bytesRead !== length) throw new Error('Incomplete object storage metadata.');
        const meta = JSON.parse(metadata.toString('utf8')), stat = await file.stat(), offset = 4 + length;
        if (meta.version !== 1 || !Number.isInteger(meta.size) || meta.size < 0 || meta.size > OBJECT_LIMIT || !stat.isFile() || stat.size !== offset + meta.size) throw new Error('Invalid object storage body.');
        const type = contentType(meta.contentType);
        const stream = file.createReadStream({ start: offset, autoClose: true });
        const body = Readable.toWeb(stream);
        return { body, size: meta.size, httpMetadata: { contentType: type }, arrayBuffer: () => new Response(body).arrayBuffer() };
      } catch (error) { await file.close().catch(() => {}); throw error; }
    },
    async delete(key) { const target = path.join(root, objectKey(key)); let removed = true; await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; removed = false; }); if (removed) await syncDirectory(); }
  };
}
