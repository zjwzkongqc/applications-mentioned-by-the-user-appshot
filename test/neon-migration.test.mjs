import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { sendNeonBackup } from '../scripts/send-neon-backup.mjs';
import { createOwnerImportHandler, OWNER_IMPORT_PATH } from '../supabase/functions/tennis-api/owner-import.mjs';
import { migrationConfig } from '../supabase/functions/tennis-api/migration-config.mjs';
import { TABLE_NAMES } from '../supabase/functions/tennis-api/import.mjs';
import { neonOrigin } from '../neon/functions/tennis-api/storage.mjs';

const ORIGIN = 'https://br-test-tennisapi.compute.test.ap-southeast-1.aws.neon.tech';
const IMPORT_PATH = '/api/_owner/migration-import';
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tennis-neon-private-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const input = path.join(directory, 'snapshot.json'), signingKey = path.join(directory, 'key.pk8');
  await fs.writeFile(signingKey, keys.privateKey.export({ format: 'der', type: 'pkcs8' }), { mode: 0o600 });
  await fs.writeFile(input, JSON.stringify({ formatVersion: 1, appId: 'tennis-dazi-club-2026', schemaVersion: 5, createdAt: new Date().toISOString(), fromApiOrigin: migrationConfig.fromApiOrigin, tables: Object.fromEntries(TABLE_NAMES.map(name => [name, []])), avatars: [] }), { mode: 0o600 });
  return { input, signingKey, publicKey: keys.publicKey.export({ format: 'jwk' }) };
}

test('Neon private sender signs the exact Neon path and refuses replay against a different path or project', async t => {
  const f = await fixture(t); let imports = 0;
  const make = (origin, importPath = IMPORT_PATH) => createOwnerImportHandler({ publicOrigin: origin, importPath, validatePublicOrigin: neonOrigin, ...migrationConfig, publicKey: f.publicKey, readReceipt: async () => null,
    importSnapshot: async ({ snapshotJson, metadata }) => {
      imports++; assert.equal(snapshotJson, await fs.readFile(f.input, 'utf8'));
      return { formatVersion: 1, appId: 'tennis-dazi-club-2026', schemaVersion: 5, ...metadata, credentialsPreserved: true, importedAt: new Date().toISOString(), tableCounts: Object.fromEntries(TABLE_NAMES.map(name => [name, 0])), avatarCount: 0 };
    } });
  const handler = make(ORIGIN); let captured;
  const receipt = await sendNeonBackup({ ...f, origin: ORIGIN, fetch: async (url, options) => {
    captured = { url, options }; assert.equal(url, ORIGIN + IMPORT_PATH); assert.equal(options.redirect, 'error');
    assert.equal(Object.keys(options.headers).some(name => /authorization|cookie|origin/i.test(name)), false);
    return handler(new Request(url, options));
  } });
  assert.equal(receipt.toApiOrigin, ORIGIN); assert.equal(imports, 1);
  assert.equal((await make(ORIGIN, OWNER_IMPORT_PATH)(new Request(ORIGIN + OWNER_IMPORT_PATH, captured.options))).status, 404);
  const other = 'https://br-other-tennisapi.compute.test.ap-southeast-1.aws.neon.tech';
  assert.equal((await make(other)(new Request(other + IMPORT_PATH, captured.options))).status, 404);
  assert.equal(imports, 1);
});

test('Neon sender accepts only an explicit platform HTTPS origin and bounded private files', async t => {
  const f = await fixture(t); let calls = 0;
  const request = async () => { calls++; throw new Error('must not run'); };
  for (const origin of [ORIGIN.replace('https:', 'http:'), ORIGIN + '/api', ORIGIN + '.evil.test', ORIGIN.replace('https://', 'https://owner:secret@'), ORIGIN + '?key=private', 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co']) {
    await assert.rejects(sendNeonBackup({ ...f, origin, fetch: request }));
  }
  await fs.chmod(f.input, 0o644);
  await assert.rejects(sendNeonBackup({ ...f, origin: ORIGIN, fetch: request }));
  assert.equal(calls, 0);
});

test('a matching Neon identity without complete table/media counts cannot confirm migration', async t => {
  const f = await fixture(t);
  await assert.rejects(sendNeonBackup({ ...f, origin: ORIGIN, fetch: async (_url, options) => new Response(JSON.stringify({ imported: true, receipt: {
    ...migrationConfig, toApiOrigin: ORIGIN, appId: 'tennis-dazi-club-2026', formatVersion: 1, schemaVersion: 5,
    credentialsPreserved: true, importedAt: new Date().toISOString(), sourceSnapshotSha256: options.headers['X-Tennis-Import-SHA256']
  } }), { status: 200 }) }));
});
