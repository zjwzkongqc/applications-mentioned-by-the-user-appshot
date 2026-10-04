import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { zipSync, strToU8 } from 'fflate';
import { deployNeon, expectedNeonSchema, neonFunctionOrigin } from '../scripts/deploy-neon.mjs';

const PROJECT = 'gentle-tennis-12345678';
const BRANCH = 'br-green-court-12345678';
const ORG = 'org-tennis-club-12345678';
const TOKEN = 'private-deployment-credential-only-in-secret';
const DBHOST = 'ep-green-court-12345678.ap-southeast-1.aws.neon.tech';
const ORIGIN = 'https://' + BRANCH + '-tennisapi.compute.c-1.ap-southeast-1.aws.neon.tech';
const SCHEMA = await fs.readFile(new URL('../neon/schema.sql', import.meta.url), 'utf8');
const EXPECTED = expectedNeonSchema(SCHEMA);
const ZIP = zipSync({ 'index.mjs': strToU8('export default {fetch: async () => new Response("unconfigured", {status:503})};') });
const copy = value => structuredClone(value);

function fixture({ existingSchema = true, existingFunction = true, existingBucket = true, overrides = {}, mutateSchema } = {}) {
  let schemaReady = existingSchema;
  let functionReady = existingFunction;
  let bucketReady = existingBucket;
  let deploymentId = 1;
  const calls = [], dbCalls = [], mutations = [];
  const sql = {
    async unsafe(statement) {
      dbCalls.push(statement);
      if (statement.startsWith('SELECT pg_advisory_xact_lock')) return [];
      if (statement === SCHEMA) { schemaReady = true; mutations.push('schema'); return []; }
      if (statement.startsWith('SELECT (SELECT count(*)')) return [{ row_count: overrides.rowCount ?? '0' }];
      if (!schemaReady) return [];
      if (statement.includes('c.relrowsecurity')) return mutateSchema ? mutateSchema('tables', copy(EXPECTED.tables)) : copy(EXPECTED.tables);
      if (statement.includes('information_schema.columns')) return mutateSchema ? mutateSchema('columns', copy(EXPECTED.columns)) : copy(EXPECTED.columns);
      if (statement.includes('pg_catalog.pg_index')) return mutateSchema ? mutateSchema('indexes', copy(EXPECTED.indexes)) : copy(EXPECTED.indexes);
      if (statement.includes('pg_catalog.pg_constraint')) return mutateSchema ? mutateSchema('constraints', copy(EXPECTED.constraints)) : copy(EXPECTED.constraints);
      throw new Error('Unexpected SQL in test');
    },
    async begin(mode, callback) { assert.equal(mode, 'READ WRITE'); dbCalls.push('BEGIN'); try { const value = await callback(sql); dbCalls.push('COMMIT'); return value; } catch (error) { dbCalls.push('ROLLBACK'); throw error; } },
    async end() { dbCalls.push('CLOSED'); }
  };
  const api = 'https://console.neon.tech/api/v2';
  const base = api + '/projects/' + PROJECT;
  const branch = base + '/branches/' + BRANCH;
  const fn = branch + '/functions/tennisapi';
  async function request(url, options) {
    assert.equal(options.headers.Authorization, 'Bearer ' + TOKEN);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(url.startsWith(api + '/'));
    calls.push({ url, options });
    const route = url.slice(api.length);
    let data, status = 200;
    if (url === base) data = { project: { id: PROJECT, org_id: ORG, region_id: 'aws-ap-southeast-1', owner: { subscription_type: 'free_v3' }, ...overrides.project } };
    else if (url === api + '/organizations/' + ORG) data = { id: ORG, plan: overrides.plan ?? 'free' };
    else if (url === branch) data = { branch: { id: BRANCH, project_id: PROJECT, current_state: 'ready', ...overrides.branch } };
    else if (url === base + '/endpoints') data = { endpoints: [{ id: 'ep-green-court-12345678', branch_id: BRANCH, project_id: PROJECT, type: 'read_write', current_state: 'idle', disabled: false, host: DBHOST, ...overrides.endpoint }] };
    else if (url === branch + '/databases') data = { databases: overrides.databases ?? [{ name: 'neondb', owner_name: 'neondb_owner', branch_id: BRANCH }] };
    else if (url === branch + '/functions') data = { functions: functionReady ? [{ slug: 'tennisapi', invocation_url: overrides.invocationUrl ?? ORIGIN + '/' }] : [] };
    else if (url === branch + '/buckets' && options.method !== 'POST') data = { buckets: bucketReady ? [{ name: 'tennis-avatars', access_level: overrides.accessLevel ?? 'private' }] : [] };
    else if (url === branch + '/buckets') {
      mutations.push('bucket'); bucketReady = true; status = 201;
      assert.deepEqual(JSON.parse(options.body), { name: 'tennis-avatars', access_level: 'private' });
      data = { bucket: { name: 'tennis-avatars', access_level: 'private' } };
    }
    else if (url.startsWith(base + '/connection_uri?')) {
      const params = new URL(url).searchParams;
      assert.equal(params.get('branch_id'), BRANCH);
      assert.equal(params.get('endpoint_id'), 'ep-green-court-12345678');
      assert.equal(params.get('pooled'), 'false');
      data = { uri: overrides.uri ?? 'postgresql://neondb_owner:private-db-password@' + DBHOST + '/neondb?sslmode=require' };
    }
    else if (url === fn + '/deployments') {
      mutations.push('function'); functionReady = true; deploymentId++; status = 201;
      assert.equal(options.body.get('runtime'), 'nodejs24');
      data = { deployment: { id: deploymentId, status: 'pending' } };
    }
    else if (url === fn) data = { function: { slug: 'tennisapi', invocation_url: overrides.invocationUrl ?? ORIGIN + '/', current_deployment: { id: deploymentId, status: overrides.deploymentStatus ?? 'completed' }, active_deployment: { id: deploymentId, status: 'completed' } } };
    else throw new Error('Unexpected endpoint in test');
    const override = overrides.response?.(route, options, calls);
    if (override) return override;
    return new Response(JSON.stringify(data), { status });
  }
  return { options: { projectId: PROJECT, branchId: BRANCH, apiKey: TOKEN, request, delay: async () => {}, maxPolls: 2,
    connectDatabase: async uri => { assert.ok(uri.includes(DBHOST)); return sql; }, readFile: async filename => filename.endsWith('schema.sql') ? SCHEMA : ZIP }, calls, dbCalls, mutations };
}

test('invalid public IDs, private authorization and polling limits fail before any network access', async () => {
  for (const change of [{ projectId: '../projects/other' }, { branchId: 'main' }, { branchId: 'br-x/../bad' }, { apiKey: '' }, { apiKey: TOKEN + '\r\n' }, { maxPolls: 81 }]) {
    let called = false;
    await assert.rejects(deployNeon({ projectId: PROJECT, branchId: BRANCH, apiKey: TOKEN, ...change, request: async () => { called = true; } }));
    assert.equal(called, false);
  }
});

test('paid, trial, unknown or changed ownership plans cannot initialize a database or deploy a resource', async () => {
  for (const overrides of [{ plan: 'launch' }, { plan: 'trial' }, { plan: 'UNKNOWN' }, { project: { owner: { subscription_type: 'launch_v3' } } }, { project: { org_id: 'org-other-12345678' } }]) {
    const env = fixture({ existingSchema: false, existingBucket: false, existingFunction: false, overrides });
    await assert.rejects(deployNeon(env.options));
    assert.deepEqual(env.mutations, []);
    assert.deepEqual(env.dbCalls, []);
  }
});

test('an owner without a billing account requires authoritative organization Free proof', async () => {
  const unbilled = { owner: { subscription_type: 'UNKNOWN' } };
  const free = fixture({ overrides: { project: unbilled } });
  assert.equal((await deployNeon(free.options)).provider, 'neon-free');
  for (const overrides of [
    { project: unbilled, plan: 'launch' },
    { project: unbilled, response: route => route.startsWith('/organizations/') ? new Response('{}') : null }
  ]) {
    const rejected = fixture({ existingSchema: false, existingFunction: false, existingBucket: false, overrides });
    await assert.rejects(deployNeon(rejected.options));
    assert.deepEqual(rejected.mutations, []);
    assert.deepEqual(rejected.dbCalls, []);
  }
});

test('branch, compute, database, connection identity and public bucket must be trustworthy before deployment', async () => {
  for (const overrides of [{ branch: { current_state: 'resetting' } }, { endpoint: { disabled: true } }, { endpoint: { current_state: 'init' } }, { endpoint: { host: 'database.attacker.example' } }, { databases: [{ name: 'a', owner_name: 'owner', branch_id: BRANCH }, { name: 'b', owner_name: 'owner', branch_id: BRANCH }] }, { databases: [{ name: 'customdb', owner_name: 'owner', branch_id: BRANCH }] }, { databases: [{ name: 'neondb', owner_name: 'customowner', branch_id: BRANCH }] }, { accessLevel: 'public_read' }, { uri: 'postgresql://owner:password@attacker.example/database' }]) {
    const env = fixture({ overrides });
    await assert.rejects(deployNeon(env.options));
    assert.deepEqual(env.mutations, []);
  }
});

test('complete schema and existing private bucket deploy only reviewed code with trusted public origin', async () => {
  const env = fixture();
  const result = await deployNeon(env.options);
  assert.deepEqual(result, { deployed: true, provider: 'neon-free', apiOrigin: ORIGIN, apiPathPrefix: '', migrationPending: true, cutoverPerformed: false });
  assert.deepEqual(env.mutations, ['function']);
  assert.equal(env.dbCalls.includes(SCHEMA), false);
  const deploy = env.calls.find(call => call.url.endsWith('/deployments'));
  assert.ok(deploy.options.body.get('zip'));
  assert.deepEqual(JSON.parse(deploy.options.body.get('environment')), { TENNIS_BUCKET: 'tennis-avatars', TENNIS_PUBLIC_ORIGIN: ORIGIN });
  assert.equal(JSON.stringify(result).includes('private-db-password'), false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('fresh initialization is atomic and the first address discovery deploy remains fail-closed until configuration', async () => {
  const env = fixture({ existingSchema: false, existingBucket: false, existingFunction: false });
  const result = await deployNeon(env.options);
  assert.deepEqual(env.mutations, ['schema', 'bucket', 'function', 'function']);
  assert.ok(env.dbCalls.indexOf('BEGIN') < env.dbCalls.indexOf(SCHEMA));
  assert.ok(env.dbCalls.indexOf(SCHEMA) < env.dbCalls.indexOf('COMMIT'));
  assert.equal(/\b(?:DELETE\s+FROM|TRUNCATE\s+(?:TABLE\s+)?|DROP\s+TABLE)\b/.test(SCHEMA), false);
  assert.equal(SCHEMA.includes('storage.buckets'), false);
  const deploys = env.calls.filter(call => call.url.endsWith('/deployments'));
  assert.deepEqual(JSON.parse(deploys[0].options.body.get('environment')), { TENNIS_BUCKET: 'tennis-avatars' });
  assert.ok(deploys[0].options.body.get('zip'));
  assert.deepEqual(JSON.parse(deploys[1].options.body.get('environment')), { TENNIS_BUCKET: 'tennis-avatars', TENNIS_PUBLIC_ORIGIN: ORIGIN });
  assert.equal(deploys[1].options.body.get('zip'), null);
  for (const [index, call] of env.calls.entries()) {
    if (call.options.method === 'POST') assert.equal(env.calls[index - 1].url, 'https://console.neon.tech/api/v2/organizations/' + ORG);
  }
  assert.equal(result.cutoverPerformed, false);
});

test('partial schema, missing nullable scores, missing indexes or weakened constraints cannot be overwritten', async () => {
  for (const mutateSchema of [
    (type, rows) => type === 'tables' ? rows.slice(0, 1) : rows,
    (type, rows) => type === 'columns' ? rows.filter(row => !(row.table_name === 'monthly_ratings' && row.column_name === 'serve')) : rows,
    (type, rows) => type === 'tables' ? rows.map(row => ({ ...row, row_security: false })) : rows,
    (type, rows) => type === 'indexes' ? rows.slice(1) : rows,
    (type, rows) => type === 'constraints' ? rows.map(row => row.type === 'f' ? { ...row, validated: false } : row) : rows
  ]) {
    const env = fixture({ mutateSchema });
    await assert.rejects(deployNeon(env.options));
    assert.deepEqual(env.mutations, []);
    assert.equal(env.dbCalls.at(-1), 'CLOSED');
  }
});

test('the first new function cannot attach to a populated application database', async () => {
  const env = fixture({ existingFunction: false, overrides: { rowCount: '1' } });
  await assert.rejects(deployNeon(env.options));
  assert.deepEqual(env.mutations, []);
});

test('API errors, lost acknowledgements and failed builds return no private upstream diagnostics and never cut over', async () => {
  for (const overrides of [
    { response: () => new Response(TOKEN + ':private-db-password', { status: 403 }) },
    { response: () => { throw new Error(TOKEN + ':private-db-password'); } },
    { deploymentStatus: 'failed' },
    { deploymentStatus: 'building' }
  ]) {
    const env = fixture({ overrides });
    await assert.rejects(deployNeon(env.options), error => !error.message.includes(TOKEN) && !error.message.includes('private-db-password'));
    assert.equal(env.calls.some(call => /settings\/pages|github\.com/.test(call.url)), false);
  }
});

test('untrusted runtime URLs are rejected even when returned by a platform response', () => {
  for (const value of ['http://' + new URL(ORIGIN).host + '/', ORIGIN + '/api/', ORIGIN + '/?token=x', ORIGIN + '/#secret', ORIGIN.replace(BRANCH, 'br-other-12345678'), ORIGIN.replace('neon.tech', 'neon.tech.attacker.example'), ORIGIN.replace('https://', 'https://user:pass@')]) assert.throws(() => neonFunctionOrigin(value, BRANCH));
  assert.equal(neonFunctionOrigin(ORIGIN + '/', BRANCH), ORIGIN);
});

test('archive errors and a Free plan changed before mutation fail closed', async () => {
  for (const extra of [strToU8(TOKEN), new Uint8Array(8 * 1024 * 1024 + 1)]) {
    const badZip = fixture();
    badZip.options.readFile = async filename => filename.endsWith('schema.sql') ? SCHEMA : zipSync({ 'index.mjs': strToU8('x'), 'leaked.env': extra });
    await assert.rejects(deployNeon(badZip.options));
    assert.deepEqual(badZip.mutations, []);
  }
  const changed = fixture({ existingSchema: false });
  const originalRequest = changed.options.request;
  let checks = 0;
  changed.options.request = async (url, options) => {
    if (url.endsWith('/organizations/' + ORG) && ++checks > 1) return new Response(JSON.stringify({ id: ORG, plan: 'launch' }));
    return originalRequest(url, options);
  };
  await assert.rejects(deployNeon(changed.options));
  assert.deepEqual(changed.mutations, []);
});

test('workflow is owner-triggered, read-only on GitHub and passes deployment authorization only by environment', async () => {
  const workflow = await fs.readFile(new URL('../.github/workflows/deploy-neon.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes('workflow_dispatch:'));
  assert.equal(/\n\s+(?:push|schedule|pull_request):/.test(workflow), false);
  assert.ok(workflow.includes('contents: read'));
  assert.ok(workflow.includes('persist-credentials: false'));
  assert.ok(workflow.includes('NEON_API_KEY: ${{ secrets.NEON_API_KEY }}'));
  assert.ok(workflow.includes('vars.NEON_PROJECT_ID'));
  assert.equal(workflow.includes('--api-key'), false);
  assert.equal(workflow.includes('create-branch-action'), false);
});

// The optional URL is only an isolated, owner-controlled synthetic PostgreSQL
// instance. No production database or platform credential is read by this test.
test('real PostgreSQL accepts the atomic schema, repeated deploys preserve rows, and partial schemas fail closed', { skip: !process.env.NEON_DEPLOY_TEST_DATABASE_URL }, async () => {
  const admin = postgres(process.env.NEON_DEPLOY_TEST_DATABASE_URL, { ssl: false, max: 1, onnotice: () => {} });
  const database = 'neon_deploy_qa_' + randomUUID().replaceAll('-', '');
  const url = new URL(process.env.NEON_DEPLOY_TEST_DATABASE_URL); url.pathname = '/' + database;
  let inspect;
  try {
    await admin.unsafe('CREATE DATABASE ' + database);
    const env = fixture({ existingSchema: false, existingFunction: false, existingBucket: false });
    env.options.connectDatabase = async () => postgres(url.href, { ssl: false, max: 1, prepare: false, onnotice: () => {} });
    assert.equal((await deployNeon(env.options)).deployed, true);
    inspect = postgres(url.href, { ssl: false, max: 1, prepare: false, onnotice: () => {} });
    const account = randomUUID();
    await inspect.unsafe("INSERT INTO public.accounts(id,display_name,recovery_hash,created_at) VALUES ($1, 'Synthetic preserved account', $2, '2026-10-04T00:00:00.000Z')", [account, 'a'.repeat(64)]);
    assert.equal((await deployNeon(env.options)).deployed, true);
    assert.deepEqual((await inspect.unsafe('SELECT id,display_name FROM public.accounts')).map(row => ({ ...row })), [{ id: account, display_name: 'Synthetic preserved account' }]);
    await inspect.unsafe('ALTER TABLE public.monthly_ratings ALTER COLUMN serve SET NOT NULL');
    const mutationsBefore = env.mutations.length;
    await assert.rejects(deployNeon(env.options));
    assert.equal(env.mutations.length, mutationsBefore);
    assert.equal((await inspect.unsafe('SELECT count(*) AS count FROM public.accounts'))[0].count, '1');
  } finally {
    if (inspect) await inspect.end({ timeout: 5 });
    try { await admin.unsafe('DROP DATABASE IF EXISTS ' + database + ' WITH (FORCE)'); } finally { await admin.end({ timeout: 5 }); }
  }
});
