import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const release = process.env.TENNIS_RELEASE || spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim();
if (!/^[a-f0-9]{40}$/.test(release || '')) throw new Error('TENNIS_RELEASE must identify an exact Git commit.');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${command} did not complete successfully.`);
}
const directory = path.join(root, 'dist/china');
await mkdir(directory, { recursive: true });
run('docker', ['build', '--platform', 'linux/amd64', '--file', 'deploy/china/Dockerfile', '--tag', `tennis-dazi-cn:${release}`, '.']);
const caddy = 'caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d';
run('docker', ['pull', '--platform', 'linux/amd64', caddy]);
run('docker', ['tag', caddy, 'tennis-dazi-caddy:2.10.2']);
const imagePath = path.join(directory, 'images.tar');
run('docker', ['save', '--output', imagePath, `tennis-dazi-cn:${release}`, 'tennis-dazi-caddy:2.10.2']);
await pipeline(createReadStream(imagePath), createGzip(), createWriteStream(imagePath + '.gz', { mode: 0o600 }));
const files = ['compose.yaml', 'Caddyfile', 'install.sh'];
for (const file of files) await copyFile(path.join(root, 'deploy/china', file), path.join(directory, file));
await writeFile(path.join(directory, 'RELEASE'), release + '\n');
const checksums = [];
for (const file of [...files, 'RELEASE', 'images.tar.gz']) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path.join(directory, file))) hash.update(chunk);
  checksums.push(`${hash.digest('hex')}  ${file}`);
}
await writeFile(path.join(directory, 'SHA256SUMS'), checksums.join('\n') + '\n');
run('tar', ['-czf', 'dist/tennis-china-linux-amd64.tar.gz', '-C', 'dist/china', ...files, 'RELEASE', 'SHA256SUMS', 'images.tar.gz']);
console.log('Built the complete offline package. No account data, credentials or private photos are included.');
