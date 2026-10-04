import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { migrationConfig } from '../supabase/functions/tennis-api/migration-config.mjs';
import { OWNER_IMPORT_PATH, importSignatureMessage } from '../supabase/functions/tennis-api/owner-import.mjs';
import { sha256, validateSnapshot } from '../supabase/functions/tennis-api/import.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const LIMIT = 32 * 1024 * 1024;
async function privateFile(filename, limit) {
  const resolved = await fs.realpath(filename);
  if (resolved === root.slice(0,-1) || resolved.startsWith(root)) throw new Error('Keep private migration files outside the source checkout.');
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) || before.size > limit) throw new Error('Migration input must be a bounded, private regular file.');
    const bytes = await handle.readFile(), after = await handle.stat();
    if (bytes.length > limit || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Migration input changed while reading.');
    return bytes;
  } finally { await handle.close(); }
}
export async function sendSupabaseBackup({ input, signingKey, origin, fetch: request = fetch }) {
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'https:' || !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname)) throw new Error('Specify the approved Supabase project HTTPS origin.');
  const bytes = await privateFile(input, LIMIT);
  const snapshotJson = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  await validateSnapshot(JSON.parse(snapshotJson));
  const keyBytes = await privateFile(signingKey, 4096);
  const key = createPrivateKey({ key: keyBytes, format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('The private migration signer is invalid.');
  const digest = await sha256(bytes), timestamp = String(Date.now()), nonce = randomBytes(32).toString('hex');
  const message = importSignatureMessage({ publicOrigin: origin, ...migrationConfig, digest, timestamp, nonce });
  const signature = sign('sha256', Buffer.from(message), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  let response;
  try {
    response = await request(origin + OWNER_IMPORT_PATH, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Tennis-Import-SHA256': digest,
        'X-Tennis-Import-Time': timestamp, 'X-Tennis-Import-Nonce': nonce, 'X-Tennis-Import-Signature': signature }, body: bytes,
      signal: AbortSignal.timeout(120000) });
  } catch { throw new Error('Import response was not confirmed. Inspect the destination receipt before retrying; do not change or delete data.'); }
  if (response.status !== 200) throw new Error('Destination did not confirm import. Inspect the private destination before retrying.');
  let result;
  try { result = await response.json(); } catch { throw new Error('Destination returned an invalid import receipt.'); }
  const receipt = result?.receipt;
  if (result.imported !== true || receipt?.appId !== 'tennis-dazi-club-2026' || receipt.schemaVersion !== 4 || receipt.formatVersion !== 1 || receipt.credentialsPreserved !== true || receipt.toApiOrigin !== origin || receipt.sourceSnapshotSha256 !== digest ||
      Object.entries(migrationConfig).some(([name, value]) => receipt[name] !== value)) throw new Error('Destination receipt does not match the signed migration.');
  return receipt;
}
async function main() {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = { '--input': 'input', '--signing-key': 'signingKey', '--origin': 'origin' }[args[index]];
    if (!name || !args[index + 1] || options[name]) throw new Error('Usage: node scripts/send-supabase-backup.mjs --input PRIVATE_BACKUP --signing-key PRIVATE_KEY --origin HTTPS_PROJECT_ORIGIN');
    options[name] = args[index + 1];
  }
  if (!options.input || !options.signingKey || !options.origin) throw new Error('Input, private signing key, and approved project origin are required.');
  const receipt = await sendSupabaseBackup(options);
  // Only public aggregate verification is printed; never snapshot rows or keys.
  console.log(JSON.stringify({ imported: true, sourceSnapshotSha256: receipt.sourceSnapshotSha256, tableCounts: receipt.tableCounts, avatarCount: receipt.avatarCount }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Private import was not confirmed. Inspect the destination receipt before retrying.'); process.exitCode = 1; });
