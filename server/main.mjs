import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { createDatabase, createBucket } from './storage.mjs';
import { createAppServer, validatePublicOrigin } from './http.mjs';
import { createMigrationService } from './migration.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function within(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function listen(server, DB, port, host) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  let closing;
  const close = () => closing ||= new Promise((resolve, reject) => {
    server.close(error => { try { DB?.close(); } catch (failure) { reject(failure); return; } error ? reject(error) : resolve(); });
    server.closeIdleConnections();
  });
  return { server, close, port: server.address().port };
}

export async function startBackend({ dataDir, publicOrigin, host = '0.0.0.0', port = 3000, trustedProxyHops = 0, maintenanceMode = false, migrationId, migrationFromOrigin, migrationPageBaseUrl, workerPath = path.join(projectRoot, 'dist/node/worker.mjs'), migrationsDir = path.join(projectRoot, 'drizzle'), onError } = {}) {
  const origin = validatePublicOrigin(publicOrigin);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be between 0 and 65535.');
  // A deployment can be healthy while the offline importer owns DATA_DIR.
  // Do not even import assets or open/create SQLite and avatar storage here.
  if (maintenanceMode) return listen(createAppServer({ publicOrigin: origin, maintenanceMode: true, trustedProxyHops, onError }), null, port, host);
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('DATA_DIR must name a dedicated persistent directory outside the source checkout.');
  const requested = path.resolve(dataDir);
  if (requested === path.parse(requested).root || within(projectRoot, requested) || within(requested, projectRoot)) throw new Error('DATA_DIR must be separate from the source checkout.');
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const info = await lstat(requested);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('DATA_DIR must be a dedicated private directory.');
  const directory = await realpath(requested);
  if (within(projectRoot, directory) || within(directory, projectRoot)) throw new Error('DATA_DIR must be separate from the source checkout.');
  await chmod(directory, 0o700);
  const { default: worker } = await import(pathToFileURL(path.resolve(workerPath)).href);
  const DB = createDatabase({ filename: path.join(directory, 'tennis.sqlite'), migrationsDir });
  let server;
  try {
    const BUCKET = await createBucket({ directory: path.join(directory, 'avatars') });
    const migration = await createMigrationService({ DB, dataDir: directory, publicOrigin: origin, migrationId, fromApiOrigin: migrationFromOrigin, pageBaseUrl: migrationPageBaseUrl });
    server = createAppServer({ worker, env: { DB, BUCKET }, publicOrigin: origin, trustedProxyHops, migration, onError });
    return await listen(server, DB, port, host);
  } catch (error) { DB.close(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    const backend = await startBackend({
      dataDir: process.env.DATA_DIR, publicOrigin: process.env.PUBLIC_API_ORIGIN || process.env.RENDER_EXTERNAL_URL,
      host: process.env.HOST || '0.0.0.0', port: Number(process.env.PORT || 3000), trustedProxyHops: Number(process.env.TRUST_PROXY_HOPS || 0),
      migrationId: process.env.MIGRATION_ID, migrationFromOrigin: process.env.MIGRATION_FROM_ORIGIN, migrationPageBaseUrl: process.env.MIGRATION_PAGE_BASE_URL,
      maintenanceMode: process.env.MAINTENANCE_MODE === '1',
      onError: error => process.stderr.write(`[node-backend] Request failed (${error.code || 'internal'}).\n`)
    });
    process.stdout.write(JSON.stringify({ event: 'listening', port: backend.port }) + '\n');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      const deadline = setTimeout(() => process.exit(1), 10000); deadline.unref();
      backend.close().then(() => { clearTimeout(deadline); process.exit(0); }, () => process.exit(1));
    });
  } catch (error) {
    process.stderr.write(`[node-backend] Startup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
