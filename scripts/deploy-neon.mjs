import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { unzipSync } from 'fflate';
import { TABLE_COLUMNS, SCHEMA_VERSION } from './backup-format.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Management contract: https://neon.com/api_spec/release/v2.json
// Multipart deploy: https://neon.com/docs/compute/functions/deploy
const API = 'https://console.neon.tech/api/v2';
const SLUG = 'tennisapi';
const BUCKET = 'tennis-avatars';
const REGIONS = new Set(['aws-us-east-2', 'aws-us-east-1', 'aws-eu-central-1', 'aws-ap-southeast-1']);
const ID = /^[a-z0-9-]{1,60}$/;
const TABLES = [...Object.keys(TABLE_COLUMNS), 'tennis_migration_receipt'];
const PRIVATE_ERROR = 'Free backend deployment was not confirmed. Check Free project readiness and private GitHub authorization; existing application data was not overwritten.';

const INSPECT_TABLES = "SELECT c.relname AS table_name, c.relrowsecurity AS row_security FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname";
const INSPECT_COLUMNS = "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position";
const INSPECT_INDEXES = "SELECT t.relname AS table_name, i.indisunique AS is_unique, i.indisprimary AS is_primary, i.indisvalid AS is_valid, (i.indpred IS NULL AND i.indexprs IS NULL) AS plain, ARRAY(SELECT a.attname FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum, ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum ORDER BY k.ord) AS columns FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' ORDER BY t.relname";
const INSPECT_CONSTRAINTS = "SELECT t.relname AS table_name, c.contype AS type, ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum ORDER BY k.ord) AS columns, r.relname AS foreign_table, ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.attnum ORDER BY k.ord) AS foreign_columns, c.confdeltype AS delete_action, c.convalidated AS validated, CASE WHEN c.contype='c' THEN pg_get_constraintdef(c.oid) ELSE NULL END AS check_definition FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace LEFT JOIN pg_catalog.pg_class r ON r.oid=c.confrelid WHERE n.nspname='public' ORDER BY t.relname";

// This schema is derived from the reviewed, versioned local DDL. Platform
// passwords, keys, API response bodies and owner information never enter logs.
export function expectedNeonSchema(schema) {
  const columns = {}, indexes = [], constraints = [];
  const typeMap = { text: 'text', bigint: 'bigint', jsonb: 'jsonb' };
  for (const match of schema.matchAll(/CREATE TABLE public\.(\w+) \(([\s\S]*?)\n\);/g)) {
    const table = match[1]; columns[table] = [];
    for (const line of match[2].split('\n').map(value => value.trim().replace(/,$/, ''))) {
      const column = /^(\w+) (text|bigint|jsonb)\b(.*)$/.exec(line);
      if (column) {
        const [, name, type, rest] = column;
        columns[table].push({ table_name: table, column_name: name, data_type: typeMap[type], is_nullable: /\bNOT NULL\b|\bPRIMARY KEY\b/.test(rest) ? 'NO' : 'YES' });
        if (/\bPRIMARY KEY\b/.test(rest)) {
          indexes.push({ table_name: table, is_unique: true, is_primary: true, is_valid: true, plain: true, columns: [name] });
          constraints.push({ table_name: table, type: 'p', columns: [name], foreign_table: null, foreign_columns: [], delete_action: ' ', validated: true, check_definition: null });
        }
        const foreign = /REFERENCES public\.(\w+) \((\w+)\)( ON DELETE CASCADE)?/.exec(rest);
        if (foreign) constraints.push({ table_name: table, type: 'f', columns: [name], foreign_table: foreign[1], foreign_columns: [foreign[2]], delete_action: foreign[3] ? 'c' : 'a', validated: true, check_definition: null });
        if (table === 'tennis_migration_receipt' && name === 'id') constraints.push({ table_name: table, type: 'c', columns: [name], foreign_table: null, foreign_columns: [], delete_action: ' ', validated: true, check_definition: "CHECK ((id = 'current'::text))" });
      }
      const primary = /^PRIMARY KEY \(([^)]+)\)$/.exec(line);
      if (primary) {
        const names = primary[1].split(',').map(value => value.trim());
        for (const item of columns[table]) if (names.includes(item.column_name)) item.is_nullable = 'NO';
        indexes.push({ table_name: table, is_unique: true, is_primary: true, is_valid: true, plain: true, columns: names });
        constraints.push({ table_name: table, type: 'p', columns: names, foreign_table: null, foreign_columns: [], delete_action: ' ', validated: true, check_definition: null });
      }
    }
  }
  for (const match of schema.matchAll(/ALTER TABLE public\.(\w+) ADD COLUMN (\w+) (text|bigint)([^;]*);/g)) {
    columns[match[1]].push({ table_name: match[1], column_name: match[2], data_type: typeMap[match[3]], is_nullable: /\bNOT NULL\b/.test(match[4]) ? 'NO' : 'YES' });
  }
  for (const match of schema.matchAll(/CREATE (UNIQUE )?INDEX \w+ ON public\.(\w+) \(([^)]+)\);/g)) {
    indexes.push({ table_name: match[2], is_unique: Boolean(match[1]), is_primary: false, is_valid: true, plain: true, columns: match[3].split(',').map(value => value.trim()) });
  }
  if (Object.keys(columns).length !== TABLES.length || TABLES.some(table => !columns[table] || JSON.stringify(columns[table].map(row => row.column_name).sort()) !== JSON.stringify((table === 'tennis_migration_receipt' ? ['id', 'metadata'] : TABLE_COLUMNS[table]).slice().sort()))) throw new Error('The reviewed schema does not match the full version-five contract.');
  return { tables: TABLES.map(table_name => ({ table_name, row_security: true })), columns: Object.values(columns).flat(), indexes, constraints };
}
function canonicalRows(rows) {
  if (!Array.isArray(rows)) throw new Error('The target schema could not be verified.');
  return rows.map(row => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))).sort();
}
function equalRows(actual, expected) { return JSON.stringify(canonicalRows(actual)) === JSON.stringify(canonicalRows(expected)); }
async function inspectSchema(sql, expected) {
  const tables = await sql.unsafe(INSPECT_TABLES);
  if (!Array.isArray(tables)) throw new Error('The target schema could not be verified.');
  if (tables.length === 0) return 'empty';
  if (!equalRows(tables, expected.tables)) throw new Error('Use a fresh application database or the complete private version-five schema.');
  const [columns, indexes, constraints] = await Promise.all([sql.unsafe(INSPECT_COLUMNS), sql.unsafe(INSPECT_INDEXES), sql.unsafe(INSPECT_CONSTRAINTS)]);
  // Constraint text is only used for the one fixed receipt CHECK. It contains
  // no user input or rows and is never included in an error message.
  if (!equalRows(columns, expected.columns) || !equalRows(indexes, expected.indexes) || !equalRows(constraints, expected.constraints)) throw new Error('The existing schema differs from the reviewed version-five contract.');
  return 'complete';
}
export function neonFunctionOrigin(value, branchId) {
  let url;
  try { url = new URL(value); } catch { throw new Error('The trusted function address was not confirmed.'); }
  const region = '(?:us-east-2|us-east-1|eu-central-1|ap-southeast-1)';
  const host = new RegExp('^' + branchId + '-' + SLUG + '\\.compute\\.[a-z0-9-]+\\.' + region + '\\.aws\\.neon\\.tech$');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !['', '/'].includes(url.pathname) || !host.test(url.hostname)) throw new Error('The trusted function address was not confirmed.');
  return url.origin;
}
async function defaultConnect(uri) {
  // URL sslmode never overrides strict CA/hostname verification.
  const clean = new URL(uri); clean.search = '';
  return postgres(clean.href, { ssl: { rejectUnauthorized: true }, max: 1, prepare: false, connect_timeout: 20, idle_timeout: 5, onnotice: () => {} });
}

export async function deployNeon({ projectId, branchId, apiKey, request = fetch, connectDatabase = defaultConnect, readFile = fs.readFile, delay = ms => new Promise(resolve => setTimeout(resolve, ms)), maxPolls = 80 }) {
  if (!ID.test(projectId || '') || !/^br-[a-z0-9-]{1,57}$/.test(branchId || '') || typeof apiKey !== 'string' || !apiKey.length || apiKey.length > 8192 || /[\r\n\0]/.test(apiKey) || !Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 80) throw new Error('Existing public project and branch IDs plus private GitHub authorization are required.');
  const projectPath = '/projects/' + projectId;
  const branchPath = projectPath + '/branches/' + branchId;
  const functionPath = branchPath + '/functions/' + SLUG;
  const headers = { Authorization: 'Bearer ' + apiKey };
  async function api(route, options = {}, statuses = [200]) {
    let response;
    try { response = await request(API + route, { ...options, headers: { ...headers, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(120000) }); }
    catch { throw new Error('The platform response was not confirmed. Inspect project state before retrying.'); }
    if (!statuses.includes(response.status)) throw new Error('The platform rejected a scoped preparation request.');
    try { return await response.json(); } catch { throw new Error('The platform returned an invalid preparation response.'); }
  }
  let orgId;
  async function verifyFree() {
    const data = await api(projectPath);
    const project = data?.project;
    if (project?.id !== projectId || !REGIONS.has(project.region_id)) throw new Error('An existing Free project in a supported Functions and Storage region is required.');
    const currentOrg = project.org_id || project.owner_id;
    if (typeof currentOrg !== 'string' || !/^org-[a-z0-9-]{1,56}$/.test(currentOrg) || (orgId && currentOrg !== orgId)) throw new Error('The Free project owner could not be verified.');
    const subscription = project.owner?.subscription_type;
    // UNKNOWN is documented for owners without a billing account. It is
    // accepted only with the authoritative organization plan check below.
    if (subscription !== undefined && !['free_v2', 'free_v3', 'UNKNOWN'].includes(subscription)) throw new Error('The project is not proven to use the Free plan.');
    const org = await api('/organizations/' + currentOrg);
    if (org?.id !== currentOrg || org.plan !== 'free') throw new Error('The project is not proven to use the Free plan.');
    orgId = currentOrg;
  }
  await verifyFree();
  const branch = (await api(branchPath))?.branch;
  if (branch?.id !== branchId || branch.project_id !== projectId || branch.current_state !== 'ready' || branch.pending_state && branch.pending_state !== 'ready') throw new Error('The existing application branch is not ready.');
  const endpoints = (await api(projectPath + '/endpoints'))?.endpoints;
  const endpoint = Array.isArray(endpoints) && endpoints.filter(item => item?.branch_id === branchId && item.project_id === projectId && item.type === 'read_write');
  if (!endpoint || endpoint.length !== 1 || !['active', 'idle'].includes(endpoint[0].current_state) || endpoint[0].disabled !== false || !/^ep-[a-z0-9-]{1,57}$/.test(endpoint[0].id) || !/^ep-[a-z0-9-]+\.(?:[a-z0-9-]+\.)*(?:us-east-1|us-east-2|eu-central-1|ap-southeast-1)\.aws\.neon\.tech$/.test(endpoint[0].host)) throw new Error('A ready, enabled read-write compute is required.');
  const databases = (await api(branchPath + '/databases'))?.databases;
  if (!Array.isArray(databases) || databases.some(item => item.branch_id !== branchId)) throw new Error('The branch database was not confirmed.');
  // New Free projects retain the default service database and role so the
  // function's automatically injected connection resolves to this same target.
  const database = databases.find(item => item.name === 'neondb');
  if (!database || database.owner_name !== 'neondb_owner') throw new Error('The default application database and owner role were not confirmed.');
  const functions = (await api(branchPath + '/functions'))?.functions;
  if (!Array.isArray(functions) || functions.some(item => typeof item.slug !== 'string')) throw new Error('The existing function state was not confirmed.');
  const existingFunction = functions.find(item => item.slug === SLUG);
  const knownOrigin = existingFunction ? neonFunctionOrigin(existingFunction.invocation_url, branchId) : null;
  const buckets = (await api(branchPath + '/buckets'))?.buckets;
  if (!Array.isArray(buckets) || buckets.some(item => typeof item.name !== 'string')) throw new Error('The private object bucket state was not confirmed.');
  const currentBucket = buckets.find(item => item.name === BUCKET);
  if (currentBucket && currentBucket.access_level !== 'private') throw new Error('The application media bucket must be private.');
  const schema = await readFile(path.join(root, 'neon/schema.sql'), 'utf8');
  const expected = expectedNeonSchema(schema);
  const zip = await readFile(path.join(root, 'dist/neon/function.zip'));
  if (!(zip instanceof Uint8Array) || zip.length < 22 || zip.length > 10 * 1024 * 1024) throw new Error('Build the complete Node.js function before deployment.');
  let files;
  const archiveEntries = [];
  try { files = unzipSync(zip, { filter: file => { archiveEntries.push({ name: file.name, size: file.originalSize }); return file.name === 'index.mjs' && file.originalSize <= 8 * 1024 * 1024; } }); } catch { throw new Error('The reviewed function archive is invalid.'); }
  if (archiveEntries.length !== 1 || archiveEntries[0].name !== 'index.mjs' || Object.keys(files).length !== 1 || !files['index.mjs']?.length || files['index.mjs'].length > 8 * 1024 * 1024) throw new Error('The reviewed function archive requires one bounded index.mjs entry.');
  const params = new URLSearchParams({ branch_id: branchId, endpoint_id: endpoint[0].id, database_name: database.name, role_name: database.owner_name, pooled: 'false' });
  const result = await api(projectPath + '/connection_uri?' + params);
  let uri;
  try { uri = new URL(result?.uri); } catch { throw new Error('The scoped database connection was not confirmed.'); }
  if (!['postgres:', 'postgresql:'].includes(uri.protocol) || uri.hostname !== endpoint[0].host || uri.port && uri.port !== '5432' || decodeURIComponent(uri.username) !== database.owner_name || decodeURIComponent(uri.pathname.slice(1)) !== database.name || !uri.password || uri.hash) throw new Error('The scoped database connection was not confirmed.');
  let sql;
  try {
    sql = await connectDatabase(uri.href);
    let state = await inspectSchema(sql, expected);
    // First deployment discovers its public address only after upload. It must
    // not expose a populated database while trusted-origin configuration is absent.
    if (!existingFunction && state === 'complete') {
      const populated = await sql.unsafe('SELECT ' + TABLES.map(table => '(SELECT count(*) FROM public.' + table + ')').join(' + ') + ' AS row_count');
      if (populated.length !== 1 || !/^(?:0)$/.test(String(populated[0].row_count))) throw new Error('A first function deployment requires an empty application database.');
    }
    if (state === 'empty') {
      await verifyFree();
      await sql.begin('READ WRITE', async transaction => {
        await transaction.unsafe('SELECT pg_advisory_xact_lock(1413828174, ' + SCHEMA_VERSION + ')');
        // No destructive recovery from a partial, unexpected, or concurrently
        // initialized schema. All CREATEs commit together or roll back together.
        if (await inspectSchema(transaction, expected) !== 'empty') throw new Error('The target changed during initialization. Retry after inspection.');
        await transaction.unsafe(schema);
        if (await inspectSchema(transaction, expected) !== 'complete') throw new Error('The private version-five schema was not confirmed.');
      });
      state = 'complete';
    }
  } catch { throw new Error('The complete private schema was not confirmed. Existing application rows were not rewritten.'); }
  finally { if (sql) { try { await sql.end({ timeout: 5 }); } catch { /* no upstream errors in logs */ } } }
  if (!currentBucket) {
    await verifyFree();
    const created = (await api(branchPath + '/buckets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: BUCKET, access_level: 'private' }) }, [201]))?.bucket;
    if (created?.name !== BUCKET || created.access_level !== 'private') throw new Error('The private media bucket creation was not confirmed.');
  }
  // Re-read the actual access level instead of assuming a successful response
  // keeps a previously created bucket private.
  const verifiedBuckets = (await api(branchPath + '/buckets'))?.buckets;
  if (!Array.isArray(verifiedBuckets) || verifiedBuckets.filter(item => item?.name === BUCKET && item.access_level === 'private').length !== 1 || verifiedBuckets.some(item => item?.name === BUCKET && item.access_level !== 'private')) throw new Error('The media bucket privacy was not confirmed.');
  async function deployment(environment, includeZip) {
    await verifyFree();
    const form = new FormData();
    form.append('runtime', 'nodejs24');
    form.append('environment', JSON.stringify(environment));
    if (includeZip) form.append('zip', new Blob([zip], { type: 'application/zip' }), 'function.zip');
    const created = (await api(functionPath + '/deployments', { method: 'POST', body: form }, [201]))?.deployment;
    if (!Number.isSafeInteger(created?.id) || created.id < 1 || !['pending', 'building', 'completed'].includes(created.status)) throw new Error('The function deployment was not confirmed.');
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      const fn = (await api(functionPath))?.function;
      if (fn?.slug !== SLUG || fn.current_deployment?.id !== created.id) throw new Error('A concurrent function change requires inspection before retrying.');
      if (fn.current_deployment.status === 'failed') throw new Error('The function build failed; no application cutover was performed.');
      if (fn.current_deployment.status === 'completed' && fn.active_deployment?.id === created.id && fn.active_deployment.status === 'completed') return neonFunctionOrigin(fn.invocation_url, branchId);
      if (!['pending', 'building', 'completed'].includes(fn.current_deployment.status)) throw new Error('The function deployment state was not confirmed.');
      if (attempt + 1 < maxPolls) await delay(1500);
    }
    throw new Error('Function readiness timed out; inspect the deployment before retrying.');
  }
  const firstEnvironment = { TENNIS_BUCKET: BUCKET, ...(knownOrigin ? { TENNIS_PUBLIC_ORIGIN: knownOrigin } : {}) };
  const origin = await deployment(firstEnvironment, true);
  if (knownOrigin && knownOrigin !== origin) throw new Error('The function address changed and requires inspection.');
  if (!knownOrigin) {
    const readyOrigin = await deployment({ TENNIS_BUCKET: BUCKET, TENNIS_PUBLIC_ORIGIN: origin }, false);
    if (readyOrigin !== origin) throw new Error('The trusted function address changed during configuration.');
  }
  return { deployed: true, provider: 'neon-free', apiOrigin: origin, apiPathPrefix: '', migrationPending: true, cutoverPerformed: false };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--project-id' || args[2] !== '--branch-id') throw new Error('Specify existing public project and branch IDs.');
  console.log(JSON.stringify(await deployNeon({ projectId: args[1], branchId: args[3], apiKey: process.env.NEON_API_KEY })));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error(PRIVATE_ERROR); process.exitCode = 1; });
