import test from 'node:test';
import assert from 'node:assert/strict';
import { TABLE_NAMES } from '../supabase/functions/tennis-api/import.mjs';
import { deploySupabase } from '../scripts/deploy-supabase.mjs';

const REF = 'aaaaaaaaaaaaaaaaaaaa';
const TOKEN = 'TEST-PRIVATE-PAT';
const TABLES = [...TABLE_NAMES, 'tennis_migration_receipt'];

test('deployment rejects invalid project references or missing private authorization before any network call', async () => {
  for (const options of [{ projectRef: 'https://other.example', accessToken: TOKEN }, { projectRef: REF, accessToken: '' }, { projectRef: 'a'.repeat(19), accessToken: TOKEN }, { projectRef: REF, accessToken: 'key\nsecret' }]) {
    let called = false;
    await assert.rejects(deploySupabase({ ...options, request: async () => { called = true; } }));
    assert.equal(called, false);
  }
});

test('an existing schema deploys the complete function without altering data or exposing credentials', async () => {
  const calls = [];
  const result = await deploySupabase({ projectRef: REF, accessToken: TOKEN, request: async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers.Authorization, 'Bearer ' + TOKEN);
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/database/query')) {
      assert.equal(JSON.parse(options.body).read_only, true);
      return new Response(JSON.stringify(TABLES.map(tablename => ({ tablename }))), { status: 201 });
    }
    assert.equal(url, 'https://api.supabase.com/v1/projects/' + REF + '/functions/deploy?slug=tennis-api');
    assert.deepEqual(JSON.parse(options.body.get('metadata')), { entrypoint_path: 'tennis-api.ts', verify_jwt: false, name: 'tennis-api' });
    const source = await options.body.get('file').text();
    assert.ok(source.includes('Deno.serve'));
    assert.ok(source.includes('createOwnerImportHandler'));
    assert.equal(source.includes(TOKEN), false);
    return new Response('{}', { status: 201 });
  } });
  assert.equal(calls.length, 2);
  assert.deepEqual(result, { deployed: true, apiOrigin: 'https://' + REF + '.supabase.co', apiPathPrefix: '/functions/v1/tennis-api', migrationPending: true });
});

test('initialization only creates an empty schema in one transaction and never drops or rewrites application rows', async () => {
  let queries = 0;
  await deploySupabase({ projectRef: REF, accessToken: TOKEN, request: async (url, options) => {
    if (url.endsWith('/database/query')) {
      const body = JSON.parse(options.body); queries++;
      if (queries === 1) return new Response('[]', { status: 201 });
      assert.equal(body.read_only, false);
      assert.ok(body.query.startsWith('BEGIN; SELECT pg_advisory_xact_lock'));
      assert.ok(body.query.endsWith('COMMIT;'));
      assert.ok(body.query.includes('ENABLE ROW LEVEL SECURITY'));
      assert.equal(/\b(?:DELETE\s+FROM|TRUNCATE\s+(?:TABLE\s+)?|DROP\s+TABLE)\b/.test(body.query), false);
      return new Response('[]', { status: 201 });
    }
    return new Response('{}', { status: 201 });
  } });
  assert.equal(queries, 2);
});

test('partial targets, platform errors and lost acknowledgement stop deployment without returning private upstream details', async () => {
  for (const response of [new Response(JSON.stringify([{ tablename: 'accounts' }]), { status: 201 }), new Response(TOKEN, { status: 403 })]) {
    let calls = 0;
    await assert.rejects(deploySupabase({ projectRef: REF, accessToken: TOKEN, request: async () => { calls++; return response; } }), error => !error.message.includes(TOKEN));
    assert.equal(calls, 1);
  }
  await assert.rejects(deploySupabase({ projectRef: REF, accessToken: TOKEN, request: async () => { throw new Error(TOKEN); } }), error => !error.message.includes(TOKEN));
});
