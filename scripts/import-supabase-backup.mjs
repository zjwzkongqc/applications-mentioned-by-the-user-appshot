import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sha256 } from './backup-format.mjs';
import { AVATAR_BUCKET, ImportError as SupabaseImportError, createImportBucket, createImportDatabase, importPrivateSnapshot } from '../supabase/functions/tennis-api/import.mjs';

export { AVATAR_BUCKET, SupabaseImportError };
const refuse = message => { throw new SupabaseImportError(message); };
export function validateOwnerConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length !== 3 || ['SUPABASE_URL', 'ADMIN_SERVICE_ROLE_KEY', 'OWNER_DB_URL'].some(key => typeof config[key] !== 'string' || !config[key])) refuse('The three explicit private owner configuration fields are required.');
  let service, database;
  try { service = new URL(config.SUPABASE_URL); database = new URL(config.OWNER_DB_URL); } catch { refuse('Invalid private owner connection configuration.'); }
  if (service.protocol !== 'https:' || !service.hostname.endsWith('.supabase.co') || service.origin !== config.SUPABASE_URL || service.username || service.password || service.port || !['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || !database.pathname || database.pathname === '/' || /[\r\n]/.test(config.ADMIN_SERVICE_ROLE_KEY)) refuse('Invalid private owner connection configuration.');
  return config;
}
async function privateJson(filename) {
  let file;
  try {
    file = await open(path.resolve(filename), constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || (Number(before.mode) & 0o777) !== 0o600) refuse('Private input files must have mode 0600 and exactly one hard link.');
    const bytes = await file.readFile(), after = await file.stat({ bigint: true });
    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink'].some(key => before[key] !== after[key]) || after.size !== BigInt(bytes.length)) refuse('A private input changed while it was being read.');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { refuse('Private input is not valid UTF-8 JSON.'); }
    return { value, bytes };
  } catch (error) {
    if (error instanceof SupabaseImportError) throw error;
    refuse('The private input file could not be read.');
  } finally { await file?.close(); }
}
export async function loadOwnerConfig({ configFile, configStdin = false, configEnv = false }, { stdin = process.stdin, env = process.env } = {}) {
  if ([!!configFile, !!configStdin, !!configEnv].filter(Boolean).length !== 1) refuse('Select exactly one explicit private configuration source.');
  let config;
  if (configFile) config = (await privateJson(configFile)).value;
  else if (configEnv) config = Object.fromEntries(['SUPABASE_URL', 'ADMIN_SERVICE_ROLE_KEY', 'OWNER_DB_URL'].map(key => [key, env[key]]));
  else {
    const chunks = []; let size = 0;
    for await (const chunk of stdin) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 32768) refuse('Private configuration input is too large.'); chunks.push(bytes); }
    try { config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { refuse('Private configuration input is not valid JSON.'); }
  }
  return validateOwnerConfig(config);
}
export function createPrivateStorage(config, fetcher = globalThis.fetch) {
  validateOwnerConfig(config);
  return createImportBucket({ url: config.SUPABASE_URL, serviceRoleKey: config.ADMIN_SERVICE_ROLE_KEY, fetch: fetcher });
}
export async function createOwnerDatabase(config) {
  validateOwnerConfig(config);
  let postgres;
  try { postgres = (await import('postgres')).default; }
  catch { refuse('Install the pinned owner-only postgres driver before importing.'); }
  const hostname = new URL(config.OWNER_DB_URL).hostname;
  const sql = postgres(config.OWNER_DB_URL, { max: 1, connect_timeout: 15, idle_timeout: 0, ssl: ['localhost', '127.0.0.1', '[::1]'].includes(hostname) ? false : { rejectUnauthorized: true }, onnotice() {}, debug: false });
  return { ...createImportDatabase(sql), close: () => sql.end({ timeout: 5 }) };
}
export async function importSupabaseBackup(options, dependencies = {}) {
  if (!options || typeof options.snapshotPath !== 'string' || !options.snapshotPath || !/^[a-f0-9]{64}$/.test(options.migrationId || '')) refuse('An explicit private snapshot and 64-character migration identifier are required.');
  const config = validateOwnerConfig(options.config);
  if (config.SUPABASE_URL !== options.toApiOrigin) refuse('The target API origin must match the explicit Supabase service origin.');
  const input = await privateJson(options.snapshotPath);
  const metadata = { migrationId: options.migrationId, fromApiOrigin: options.fromApiOrigin, toApiOrigin: options.toApiOrigin, pageBaseUrl: options.pageBaseUrl, sourceSnapshotSha256: sha256(input.bytes) };
  const storage = dependencies.storage || createPrivateStorage(config, dependencies.fetch);
  const ownedDatabase = !dependencies.database; let database;
  try {
    database = dependencies.database || await createOwnerDatabase(config);
    return await importPrivateSnapshot({ snapshotJson: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.bytes), metadata, db: database, bucket: storage });
  } catch (error) {
    throw error instanceof SupabaseImportError ? error : new SupabaseImportError('Private import failed without publishing a verified migration receipt.');
  } finally { if (ownedDatabase && database) await database.close().catch(() => {}); }
}

export async function runSupabaseImportCli(arguments_, streams = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    if (arguments_.length === 1 && arguments_[0] === '--help') { streams.stdout.write('Private Supabase import: --snapshot FILE --migration-id 64LOWERHEX --from-api-origin ORIGIN --to-api-origin SUPABASE_ORIGIN --page-base-url GITHUB_URL; choose exactly one of --config FILE0600, --config-stdin, --config-env. Owner keys and database URLs must never be command-line arguments.\n'); return 0; }
    const fields = new Map([['--snapshot', 'snapshotPath'], ['--migration-id', 'migrationId'], ['--from-api-origin', 'fromApiOrigin'], ['--to-api-origin', 'toApiOrigin'], ['--page-base-url', 'pageBaseUrl'], ['--config', 'configFile']]);
    const options = {}, source = {};
    for (let index = 0; index < arguments_.length; index++) {
      const flag = arguments_[index];
      if (flag === '--config-stdin' || flag === '--config-env') { const name = flag === '--config-stdin' ? 'configStdin' : 'configEnv'; if (source[name]) refuse('Invalid or duplicate command-line options.'); source[name] = true; }
      else { const name = fields.get(flag), value = arguments_[++index]; if (!name || typeof value !== 'string' || value.startsWith('--') || Object.hasOwn(options, name)) refuse('Invalid or incomplete command-line options.'); options[name] = value; }
    }
    options.config = await loadOwnerConfig({ ...source, configFile: options.configFile }); delete options.configFile;
    await importSupabaseBackup(options); streams.stdout.write('Verified private Supabase import completed.\n'); return 0;
  } catch (error) { streams.stderr.write((error instanceof SupabaseImportError ? error.message : 'Private import failed; no credentials were printed.') + '\n'); return 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runSupabaseImportCli(process.argv.slice(2));
