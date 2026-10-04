import { createPostgresDatabase, postgresOptions } from '../../../supabase/functions/tennis-api/postgres.mjs';
import { createEdgeHandler } from '../../../supabase/functions/tennis-api/handler.mjs';
import { migrationConfig, ownerImportPublicKey } from '../../../supabase/functions/tennis-api/migration-config.mjs';
import { createOwnerImportHandler } from '../../../supabase/functions/tennis-api/owner-import.mjs';
import { importPrivateSnapshot } from '../../../supabase/functions/tennis-api/import.mjs';
import { createNeonBucket, neonOrigin, neonS3Options } from './storage.mjs';

export const NEON_OWNER_IMPORT_PATH = '/api/_owner/migration-import';

export function neonPostgresOptions(environment) {
  let url;
  try { url = new URL(environment.DATABASE_URL_UNPOOLED); } catch { throw new Error('The injected direct database connection is unavailable.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.password || !url.pathname.slice(1) || !/^[a-z0-9-]+\.(?:[a-z0-9-]+\.)*neon\.tech$/.test(url.hostname) || url.hostname.split('.')[0].endsWith('-pooler') || (url.port && url.port !== '5432') || url.hash) throw new Error('The injected direct database connection is invalid.');
  const ca = environment.TENNIS_DB_CA_PEM;
  if (ca && (ca.length > 20000 || !ca.includes('-----BEGIN CERTIFICATE-----') || !ca.includes('-----END CERTIFICATE-----'))) throw new Error('The database certificate configuration is invalid.');
  return { ...postgresOptions(), onnotice: () => {}, ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) } };
}

export function createNeonRuntime({ environment, worker, postgres, S3Client, commands }) {
  const publicOrigin = neonOrigin(environment.TENNIS_PUBLIC_ORIGIN);
  const maintenanceMode = environment.MAINTENANCE_MODE === '1';
  let connection, DB, BUCKET;
  if (!maintenanceMode) {
    const databaseOptions = neonPostgresOptions(environment), storageOptions = neonS3Options(environment);
    if (typeof postgres !== 'function' || typeof S3Client !== 'function') throw new Error('The private runtime dependencies are unavailable.');
    try { connection = postgres(environment.DATABASE_URL_UNPOOLED, databaseOptions); } catch { throw new Error('The private database client is unavailable.'); }
    DB = createPostgresDatabase(connection);
    BUCKET = createNeonBucket({ client: new S3Client(storageOptions), commands, bucket: environment.TENNIS_BUCKET || 'tennis-avatars' });
  }
  const application = createEdgeHandler({ worker, DB, BUCKET, publicOrigin, maintenanceMode,
    apiPrefix: '', validatePublicOrigin: neonOrigin,
    migrationId: migrationConfig.migrationId, migrationFromOrigin: migrationConfig.fromApiOrigin,
    migrationPageBaseUrl: migrationConfig.pageBaseUrl });
  const ownerImport = maintenanceMode ? null : createOwnerImportHandler({ publicOrigin, ...migrationConfig,
    importPath: NEON_OWNER_IMPORT_PATH, validatePublicOrigin: neonOrigin, publicKey: ownerImportPublicKey,
    readReceipt: async () => (await DB.prepare("SELECT metadata FROM tennis_migration_receipt WHERE id='current'").first())?.metadata,
    importSnapshot: input => importPrivateSnapshot({ ...input, db: connection, bucket: BUCKET.importBucket }) });
  return async request => (await ownerImport?.(request)) ?? application(request);
}

export function createNeonFunction({ environment = process.env, ...dependencies }) {
  let runtime;
  return { async fetch(request) {
    try { runtime ||= createNeonRuntime({ environment, ...dependencies }); return await runtime(request); }
    catch {
      // The first deployment discovers its platform invocation URL before
      // setting TENNIS_PUBLIC_ORIGIN. Fail closed without printing injected
      // credentials, using a request-host origin, or opening an empty app.
      return new Response(JSON.stringify({ error: '小本本暂时连不上，请稍后重试。' }), { status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
    }
  } };
}
