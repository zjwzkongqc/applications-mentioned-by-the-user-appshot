import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, readlink, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkChinaConfig, requiredNames } from '../scripts/china-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const remoteScript = await readFile(path.join(root, 'deploy/china/remote-deploy.sh'), 'utf8');
const release = 'a'.repeat(40), previousRelease = 'b'.repeat(40);
const valid = { CHINA_HOST: '203.0.113.1', CHINA_SSH_USER: 'deploy', CHINA_DOMAIN: 'tennis.club.cn', CHINA_SSH_PRIVATE_KEY: 'PRIVATE_TEST_MARKER', CHINA_SSH_KNOWN_HOSTS: 'HOST_KEY_TEST_MARKER' };
const hash = value => createHash('sha256').update(value).digest('hex');

test('missing domestic resources are reported by name and secret values never appear in preflight output', () => {
  assert.deepEqual(checkChinaConfig({}).missing, requiredNames);
  assert.equal(checkChinaConfig(valid).ready, true);
  const result = spawnSync(process.execPath, ['scripts/china-config.mjs'], { cwd: root, env: { ...process.env, ...valid, CHINA_DOMAIN: '' }, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /CHINA_DOMAIN/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_TEST_MARKER|HOST_KEY_TEST_MARKER|203\.0\.113\.1/);
});
test('server options reject shell commands, unexpected ports and unsuitable public hostnames', () => {
  for (const [name, value] of [['CHINA_HOST', 'host;touch /tmp/injected'], ['CHINA_SSH_USER', 'user -o ProxyCommand=bad'], ['CHINA_DOMAIN', 'tennis.cn;bad'], ['CHINA_DOMAIN', 'tennis.test'], ['CHINA_SSH_PORT', '-1'], ['CHINA_SSH_PORT', '65536']]) {
    assert.equal(checkChinaConfig({ ...valid, [name]: value }).ready, false);
  }
});

async function fixture(t, { previous = true, archiveType = 'valid' } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tennis-cn-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = path.join(directory, 'server'), source = path.join(directory, 'package'), bin = path.join(directory, 'bin');
  for (const p of [path.join(base, 'incoming'), path.join(base, 'releases'), source, bin]) await mkdir(p, { recursive: true });
  await writeFile(path.join(source, 'RELEASE'), release + '\n');
  await writeFile(path.join(source, 'images.tar.gz'), 'TEST_IMAGE_BYTES');
  for (const file of ['compose.yaml', 'Caddyfile', 'install.sh']) await writeFile(path.join(source, file), await readFile(path.join(root, 'deploy/china', file)));
  const files = ['compose.yaml', 'Caddyfile', 'install.sh', 'RELEASE', 'images.tar.gz'];
  await writeFile(path.join(source, 'SHA256SUMS'), (await Promise.all(files.map(async file => `${hash(await readFile(path.join(source, file)))}  ${file}`))).join('\n') + '\n');
  const archive = path.join(base, 'incoming', release + '-123.tar.gz');
  if (archiveType === 'link') {
    await rm(path.join(source, 'Caddyfile')); await symlink('/etc/passwd', path.join(source, 'Caddyfile'));
  }
  const tar = spawnSync('tar', ['-czf', archive, '-C', source, ...files, 'SHA256SUMS']);
  assert.equal(tar.status, 0);
  let old;
  if (previous) {
    old = path.join(base, 'releases', previousRelease + '-122-old');
    await mkdir(old);
    await writeFile(path.join(old, '.env'), `TENNIS_HOSTNAME=tennis.club.cn\nTENNIS_RELEASE=${previousRelease}\nMAINTENANCE_MODE=0\n`);
    await symlink(old, path.join(base, 'current'));
  }
  const docker = `#!/usr/bin/env bash\nset -eu\nprintf '%s|%s\\n' "$PWD" "$*" >> "$CHINA_TEST_COMMANDS"\nif [[ "$*" == *'up --detach'* && "$PWD" != *'${previousRelease}'* && "\u0024{CHINA_TEST_FAIL_BOOT:-0}" == 1 ]]; then exit 1; fi\n`;
  await writeFile(path.join(bin, 'docker'), docker, { mode: 0o700 });
  await writeFile(path.join(bin, 'curl'), `#!/usr/bin/env python3\nimport json,os,sys\nif os.environ.get('CHINA_TEST_FAIL_HEALTH')=='1': raise SystemExit(1)\nfilename=sys.argv[sys.argv.index('--dump-header')+1]\nopen(filename,'w').write('HTTP/2 200\\nX-Tennis-Release: '+os.environ['CHINA_TEST_RELEASE']+'\\n')\nprint(json.dumps({'ok':True,'maintenance':os.environ['CHINA_TEST_MODE']=='1'}))\n`, { mode: 0o700 });
  await writeFile(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 });
  return { directory, base, source, bin, old, archive, checksum: hash(await readFile(archive)) };
}
function deploy(f, options = {}) {
  const args = options.stdin ? ['-s', '--', 'tennis.club.cn', release, options.checksum || f.checksum, '123'] : ['-c', 'source "$1"; deploy_china_release "$2" tennis.club.cn "$3" "$4" 123', 'test', path.join(root, 'deploy/china/remote-deploy.sh'), f.base, release, options.checksum || f.checksum];
  return spawnSync('bash', args, {
    input: options.stdin ? remoteScript.replace('deploy_china_release /opt/tennis-deploy "$@"', 'deploy_china_release "$CHINA_TEST_BASE" "$@"') : undefined,
    encoding: 'utf8', cwd: root, env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, CHINA_TEST_BASE: f.base, CHINA_TEST_COMMANDS: path.join(f.directory, 'commands'), CHINA_TEST_RELEASE: options.healthRelease || release, CHINA_TEST_MODE: f.old ? '0' : '1', CHINA_TEST_FAIL_BOOT: options.failBoot ? '1' : '0', CHINA_TEST_FAIL_HEALTH: options.failHealth ? '1' : '0' }
  });
}
test('first installation commits only a verified release and keeps maintenance mode enabled', async t => {
  const f = await fixture(t, { previous: false }); const result = deploy(f);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"maintenance":true/);
  const current = await readlink(path.join(f.base, 'current'));
  assert.match(await readFile(path.join(current, '.env'), 'utf8'), /MAINTENANCE_MODE=1/);
});
test('the SSH stdin entrypoint actually invokes deployment without BASH_SOURCE being set', async t => {
  const f = await fixture(t, { previous: false }); const result = deploy(f, { stdin: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CHINA_DEPLOY_RESULT/);
  assert.ok((await readlink(path.join(f.base, 'current'))).startsWith(path.join(f.base, 'releases')));
});
test('successful upgrade preserves operating mode and commits a new immutable directory', async t => {
  const f = await fixture(t); const result = deploy(f);
  assert.equal(result.status, 0, result.stderr);
  const current = await readlink(path.join(f.base, 'current'));
  assert.notEqual(current, f.old);
  assert.match(await readFile(path.join(current, '.env'), 'utf8'), /MAINTENANCE_MODE=0/);
  assert.match(await readFile(path.join(f.old, '.env'), 'utf8'), new RegExp(previousRelease));
});
test('failed startup restores the old application and leaves its committed settings untouched', async t => {
  const f = await fixture(t); const result = deploy(f, { failBoot: true });
  assert.notEqual(result.status, 0);
  assert.equal(await readlink(path.join(f.base, 'current')), f.old);
  assert.match(await readFile(path.join(f.old, '.env'), 'utf8'), new RegExp(previousRelease));
  const commands = await readFile(path.join(f.directory, 'commands'), 'utf8');
  assert.match(commands, new RegExp(previousRelease + '[^\\n]*up --detach'));
  assert.doesNotMatch(commands, /down|--volumes|volume rm/);
});
test('a healthy response from a different release cannot commit the candidate', async t => {
  const f = await fixture(t); const result = deploy(f, { healthRelease: previousRelease });
  assert.notEqual(result.status, 0);
  assert.equal(await readlink(path.join(f.base, 'current')), f.old);
});
test('corrupted package and archive links are rejected before Docker changes', async t => {
  for (const options of [{ checksum: '0'.repeat(64) }, { archiveType: 'link' }]) {
    const f = await fixture(t, options); const result = deploy(f, options);
    assert.notEqual(result.status, 0);
    assert.equal(await readlink(path.join(f.base, 'current')), f.old);
    assert.equal((await readdir(f.directory)).includes('commands'), false);
  }
});
