import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkChinaConfig } from './china-config.mjs';

const config = checkChinaConfig(process.env);
if (!config.ready) throw new Error(`Server connection is incomplete: ${[...config.missing, ...config.invalid].join(', ')}`);
const release = process.env.TENNIS_RELEASE;
const runId = process.env.GITHUB_RUN_ID;
if (!/^[a-f0-9]{40}$/.test(release || '') || !/^\d{1,20}$/.test(runId || '')) throw new Error('A verified workflow release and run identifier are required.');
const root = fileURLToPath(new URL('../', import.meta.url));
const packagePath = path.join(root, 'dist/tennis-china-linux-amd64.tar.gz');
const hash = createHash('sha256');
for await (const chunk of createReadStream(packagePath)) hash.update(chunk);
const checksum = hash.digest('hex');
const directory = await mkdtemp(path.join(tmpdir(), 'tennis-cn-ssh-'));
const keyPath = path.join(directory, 'key'), hostsPath = path.join(directory, 'known_hosts');
async function command(program, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { if (output.length < 100000) output += chunk; });
    child.stderr.resume();
    child.on('error', () => reject(new Error(`${program} could not start.`)));
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`${program} failed. Check server access and the private deployment log; secret values are omitted.`)));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
try {
  await writeFile(keyPath, process.env.CHINA_SSH_PRIVATE_KEY.trim() + '\n', { mode: 0o600 });
  await writeFile(hostsPath, process.env.CHINA_SSH_KNOWN_HOSTS.trim() + '\n', { mode: 0o600 });
  const common = ['-i', keyPath, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${hostsPath}`, '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
  const target = `${process.env.CHINA_SSH_USER}@${process.env.CHINA_HOST}`, port = process.env.CHINA_SSH_PORT || '22';
  console.log('Connecting to the configured domestic server with a pinned host key.');
  await command('ssh', [...common, '-p', port, target, 'install -d -m 700 /opt/tennis-deploy/incoming']);
  await command('scp', [...common, '-P', port, packagePath, `${target}:/opt/tennis-deploy/incoming/${release}-${runId}.tar.gz`]);
  const script = await readFile(path.join(root, 'deploy/china/remote-deploy.sh'), 'utf8');
  const output = await command('ssh', [...common, '-p', port, target, `bash -s -- ${process.env.CHINA_DOMAIN} ${release} ${checksum} ${runId}`], script);
  const resultLine = output.split('\n').find(line => line.startsWith('CHINA_DEPLOY_RESULT '));
  if (!resultLine) throw new Error('The server did not confirm deployment.');
  const result = JSON.parse(resultLine.slice('CHINA_DEPLOY_RESULT '.length));
  if (result.deployed !== true || typeof result.maintenance !== 'boolean') throw new Error('The server returned an invalid deployment receipt.');
  console.log(result.maintenance ? 'Deployment confirmed in maintenance mode. Original data import and domestic phone testing remain required.' : 'Deployment confirmed, with the existing operating mode preserved.');
} finally { await rm(directory, { recursive: true, force: true }); }
