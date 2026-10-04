import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { sendSupabaseBackup } from '../scripts/send-supabase-backup.mjs';
import { createOwnerImportHandler } from '../supabase/functions/tennis-api/owner-import.mjs';
import { migrationConfig } from '../supabase/functions/tennis-api/migration-config.mjs';
import { TABLE_NAMES } from '../supabase/functions/tennis-api/import.mjs';

const ORIGIN = 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co';
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tennis-private-sender-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const input = path.join(directory, 'snapshot.json'), signingKey = path.join(directory, 'key.pk8');
  await fs.writeFile(signingKey, keys.privateKey.export({ format: 'der', type: 'pkcs8' }), { mode: 0o600 });
  await fs.writeFile(input, JSON.stringify({ formatVersion: 1, appId: 'tennis-dazi-club-2026', schemaVersion: 5, createdAt: new Date().toISOString(), fromApiOrigin: migrationConfig.fromApiOrigin, tables: Object.fromEntries(TABLE_NAMES.map(name => [name, []])), avatars: [] }), { mode: 0o600 });
  return { input, signingKey, publicKey: keys.publicKey.export({ format: 'jwk' }) };
}
test('private sender and receiver agree on real ECDSA signatures, exact snapshot bytes and destination receipt', async t => {
  const f = await fixture(t); let calls = 0;
  const handler = createOwnerImportHandler({ publicOrigin: ORIGIN, ...migrationConfig, publicKey: f.publicKey, readReceipt: async () => null,
    importSnapshot: async ({ snapshotJson, metadata }) => {
      assert.equal(snapshotJson, await fs.readFile(f.input, 'utf8'));
      return { formatVersion: 1, appId: 'tennis-dazi-club-2026', schemaVersion: 5, ...metadata, credentialsPreserved: true, importedAt: new Date().toISOString(), tableCounts: Object.fromEntries(TABLE_NAMES.map(name => [name, 0])), avatarCount: 0 };
    } });
  const receipt = await sendSupabaseBackup({ ...f, origin: ORIGIN, fetch: async (url, options) => {
    calls++; assert.equal(options.redirect, 'error');
    assert.equal(Object.keys(options.headers).some(name => /authorization|cookie|origin/i.test(name)), false);
    return handler(new Request(url, options));
  } });
  assert.equal(calls, 1); assert.equal(receipt.toApiOrigin, ORIGIN); assert.equal(receipt.migrationId, migrationConfig.migrationId);
});
test('sender refuses insecure destinations and non-private or symlink inputs before sending data', async t => {
  const f = await fixture(t); let calls = 0; const request = async () => { calls++; throw new Error(); };
  for (const origin of ['http://aaaaaaaaaaaaaaaaaaaa.supabase.co', ORIGIN + '/functions', 'https://owner:secret@aaaaaaaaaaaaaaaaaaaa.supabase.co', 'https://other.example']) await assert.rejects(sendSupabaseBackup({ ...f, origin, fetch: request }));
  await fs.chmod(f.input, 0o644); await assert.rejects(sendSupabaseBackup({ ...f, origin: ORIGIN, fetch: request }));
  await fs.chmod(f.input, 0o600); const link = f.input + '.link'; await fs.symlink(f.input, link);
  await assert.rejects(sendSupabaseBackup({ ...f, input: link, origin: ORIGIN, fetch: request }));
  assert.equal(calls, 0);
});
test('sender refuses mismatched import receipts and sanitizes network errors', async t => {
  const f = await fixture(t);
  await assert.rejects(sendSupabaseBackup({ ...f, origin: ORIGIN, fetch: async () => new Response(JSON.stringify({ imported: true, receipt: { toApiOrigin: 'https://other.example' } }), { status: 200 }) }));
  await assert.rejects(sendSupabaseBackup({ ...f, origin: ORIGIN, fetch: async () => { throw new Error('TEST-PRIVATE-OWNER-CREDENTIAL'); } }), error => !error.message.includes('TEST-PRIVATE-OWNER-CREDENTIAL'));
});
