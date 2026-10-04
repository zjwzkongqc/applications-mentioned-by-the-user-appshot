import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendSupabaseBackup } from './send-supabase-backup.mjs';
import { neonOrigin } from '../neon/functions/tennis-api/storage.mjs';

export function sendNeonBackup(options) {
  return sendSupabaseBackup({ ...options, importPath: '/api/_owner/migration-import', validatePublicOrigin: neonOrigin });
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = { '--input': 'input', '--signing-key': 'signingKey', '--origin': 'origin' }[args[index]];
    if (!name || !args[index + 1] || options[name]) throw new Error('Specify private input, signing key and the verified Neon function origin.');
    options[name] = args[index + 1];
  }
  if (!options.input || !options.signingKey || !options.origin) throw new Error('Private migration configuration is required.');
  const receipt = await sendNeonBackup(options);
  console.log(JSON.stringify({ imported: true, sourceSnapshotSha256: receipt.sourceSnapshotSha256, tableCounts: receipt.tableCounts, avatarCount: receipt.avatarCount }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('Private import was not confirmed. Inspect the destination receipt before retrying; no source data was changed.');
  process.exitCode = 1;
});
