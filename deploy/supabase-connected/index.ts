// API-only deployment. Remote sources are pinned to an immutable Git commit.
import postgres from 'npm:postgres@3.4.7';
import originalWorker from 'https://raw.githubusercontent.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/ffbdc4b892be0da9d0674e77b00f524b5dfcd18b/src/worker.js';
import { createPostgresDatabase, postgresOptions } from 'https://raw.githubusercontent.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/ffbdc4b892be0da9d0674e77b00f524b5dfcd18b/supabase/functions/tennis-api/postgres.mjs';
import { createSupabaseBucket, supabaseOrigin } from 'https://raw.githubusercontent.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/ffbdc4b892be0da9d0674e77b00f524b5dfcd18b/supabase/functions/tennis-api/storage.mjs';
import { createEdgeHandler } from 'https://raw.githubusercontent.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/ffbdc4b892be0da9d0674e77b00f524b5dfcd18b/supabase/functions/tennis-api/handler.mjs';
import { migrationConfig, ownerImportPublicKey } from 'https://raw.githubusercontent.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/ffbdc4b892be0da9d0674e77b00f524b5dfcd18b/supabase/functions/tennis-api/migration-config.mjs';
import { createOwnerImportHandler } from 'https://raw.githubusercontent.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/ffbdc4b892be0da9d0674e77b00f524b5dfcd18b/supabase/functions/tennis-api/owner-import.mjs';
import { importPrivateSnapshot, createImportBucket } from 'https://raw.githubusercontent.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/ffbdc4b892be0da9d0674e77b00f524b5dfcd18b/supabase/functions/tennis-api/import.mjs';
import { canonicalRequest } from './canonical-request.mjs';

const publicOrigin = supabaseOrigin(Deno.env.get('SUPABASE_URL'));
const maintenanceMode = Deno.env.get('MAINTENANCE_MODE') === '1';
let DB;
let BUCKET;
let databaseConnection;
if (!maintenanceMode) {
  const databaseUrl = Deno.env.get('SUPABASE_DB_URL');
  if (!databaseUrl) throw new Error('The platform database configuration is unavailable.');
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
const worker = {
  fetch(request, env) {
    if (!new URL(request.url).pathname.startsWith('/api/')) return new Response(null, { status: 404 });
    return originalWorker.fetch(request, env);
  }
};
const application = createEdgeHandler({ worker, DB, BUCKET, publicOrigin, maintenanceMode,
  migrationId: migrationConfig.migrationId,
  migrationFromOrigin: migrationConfig.fromApiOrigin,
  migrationPageBaseUrl: migrationConfig.pageBaseUrl
});
const ownerImport = maintenanceMode ? null : createOwnerImportHandler({
  publicOrigin, ...migrationConfig, publicKey: ownerImportPublicKey,
  readReceipt: async () => (await DB.prepare("SELECT metadata FROM tennis_migration_receipt WHERE id='current'").first())?.metadata,
  importSnapshot: (input) => importPrivateSnapshot({ ...input, db: databaseConnection,
    bucket: createImportBucket({ url: publicOrigin, serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') }) })
});
Deno.serve(async request => {
  const normalized = canonicalRequest(request, publicOrigin);
  if (!normalized) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return (await ownerImport?.(normalized)) ?? application(normalized);
});
