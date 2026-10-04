import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const TABLES = ['accounts','account_sessions','auth_failures','auth_registrations','clubs','club_invites','members','records','checkins','cheers','culture','tennis_migration_receipt'];

// The owner puts a scoped PAT in GitHub Secrets. Neither database passwords
// nor service keys are needed by the workflow or printed in its logs.
export async function deploySupabase({ projectRef, accessToken, request = fetch }) {
  if (!/^[a-z]{20}$/.test(projectRef || '') || typeof accessToken !== 'string' || !accessToken.length || /[\r\n]/.test(accessToken)) throw new Error('A project reference and private deployment authorization are required.');
  const base = 'https://api.supabase.com/v1/projects/' + projectRef;
  const headers = { Authorization: 'Bearer ' + accessToken };
  async function query(sql, readOnly) {
    let response;
    try { response = await request(base + '/database/query', { method: 'POST', redirect: 'error',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql, read_only: readOnly }), signal: AbortSignal.timeout(90000) }); }
    catch { throw new Error('Database initialization response was not confirmed. Retry without changing existing data.'); }
    if (response.status !== 201) throw new Error('Database initialization was rejected. Check project readiness and scoped token permissions.');
    try { return await response.json(); } catch { throw new Error('Database initialization returned an invalid response.'); }
  }
  const state = await query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname=\'public\' AND tablename IN (' + TABLES.map(name => "'" + name + "'").join(',') + ') ORDER BY tablename', true);
  if (!Array.isArray(state) || state.some(row => !TABLES.includes(row?.tablename))) throw new Error('Unexpected schema inspection result.');
  const existing = new Set(state.map(row => row.tablename));
  if (existing.size !== 0 && existing.size !== TABLES.length) throw new Error('The target has a partial application schema. Inspect it before deployment.');
  if (existing.size === 0) {
    const schema = await fs.readFile(path.join(root, 'supabase/migrations/20261004000000_tennis_schema.sql'), 'utf8');
    // If another deployment races, CREATE fails and the whole transaction
    // rolls back. Existing rows are never dropped, truncated or rewritten.
    await query('BEGIN; SELECT pg_advisory_xact_lock(1413828174, 4);\n' + schema + '\nCOMMIT;', false);
  }
  const source = await fs.readFile(path.join(root, 'dist/supabase/tennis-api.ts'), 'utf8');
  if (!source.length || source.length > 1024 * 1024) throw new Error('Build the complete Edge Function before deployment.');
  const form = new FormData();
  form.append('metadata', JSON.stringify({ entrypoint_path: 'tennis-api.ts', verify_jwt: false, name: 'tennis-api' }));
  form.append('file', new Blob([source], { type: 'application/typescript' }), 'tennis-api.ts');
  let response;
  try { response = await request(base + '/functions/deploy?slug=tennis-api', { method: 'POST', redirect: 'error', headers, body: form, signal: AbortSignal.timeout(120000) }); }
  catch { throw new Error('Function deployment response was not confirmed. Inspect project functions before retrying.'); }
  if (response.status !== 201) throw new Error('Function deployment was rejected. Check project readiness and scoped token permissions.');
  return { deployed: true, apiOrigin: 'https://' + projectRef + '.supabase.co', apiPathPrefix: '/functions/v1/tennis-api', migrationPending: true };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--project-ref') throw new Error('Specify --project-ref with the public project reference.');
  const result = await deploySupabase({ projectRef: args[1], accessToken: process.env.SUPABASE_ACCESS_TOKEN });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Free backend deployment was not confirmed. Check project readiness and GitHub Secret permissions; no application data was overwritten.'); process.exitCode = 1; });
