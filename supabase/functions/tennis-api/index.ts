import postgres from 'npm:postgres@3.4.7';
import worker from './worker.mjs';
import { createPostgresDatabase, postgresOptions } from './postgres.mjs';
import { createSupabaseBucket, supabaseOrigin } from './storage.mjs';
import { createEdgeHandler } from './handler.mjs';
import { migrationConfig, ownerImportPublicKey } from './migration-config.mjs';
import { createOwnerImportHandler } from './owner-import.mjs';
import { importPrivateSnapshot, createImportBucket } from './import.mjs';

const publicOrigin = supabaseOrigin(Deno.env.get('SUPABASE_URL'));
const maintenanceMode = Deno.env.get('MAINTENANCE_MODE') === '1';
let DB: ReturnType<typeof createPostgresDatabase> | undefined;
let BUCKET: ReturnType<typeof createSupabaseBucket> | undefined;
let databaseConnection: ReturnType<typeof postgres> | undefined;
if (!maintenanceMode) {
  const databaseUrl = Deno.env.get('SUPABASE_DB_URL');
  if (!databaseUrl) throw new Error('The platform database configuration is unavailable.');
  // The platform injects this private connection string. Never accept a URL
  // from a request, forward it to the browser, or print it in an exception.
  try {
    const url = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error();
    const databaseCa = Deno.env.get('TENNIS_DB_CA_PEM');
    if (databaseCa && (databaseCa.length > 20000 || !databaseCa.includes('-----BEGIN CERTIFICATE-----') || !databaseCa.includes('-----END CERTIFICATE-----'))) throw new Error();
    databaseConnection = postgres(databaseUrl, { ...postgresOptions(), ssl: { rejectUnauthorized: true, ...(databaseCa ? { ca: databaseCa } : {}) } });
    DB = createPostgresDatabase(databaseConnection);
  } catch { throw new Error('The platform database configuration is invalid.'); }
  BUCKET = createSupabaseBucket({ url: publicOrigin, serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') });
}
const application = createEdgeHandler({ worker, DB, BUCKET, publicOrigin, maintenanceMode,
  migrationId: migrationConfig.migrationId, migrationFromOrigin: migrationConfig.fromApiOrigin,
  migrationPageBaseUrl: migrationConfig.pageBaseUrl
});
const ownerImport = maintenanceMode ? null : createOwnerImportHandler({
  publicOrigin, ...migrationConfig, publicKey: ownerImportPublicKey,
  readReceipt: async () => (await DB!.prepare("SELECT metadata FROM tennis_migration_receipt WHERE id='current'").first())?.metadata,
  importSnapshot: (input: Pick<Parameters<typeof importPrivateSnapshot>[0], 'snapshotJson' | 'metadata'>) => importPrivateSnapshot({ ...input, db: databaseConnection,
    bucket: createImportBucket({ url: publicOrigin, serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') }) })
});
Deno.serve(async request => (await ownerImport?.(request)) ?? application(request));
