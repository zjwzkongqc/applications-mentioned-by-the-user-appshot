import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { buildPages, getPagesConfig, validateApiOrigin, LEGACY_API_ORIGIN, PAGES_BASE_URL } from '../scripts/build-pages.mjs';

const API = 'https://tennis-service.onrender.com';
const ID = '1'.repeat(64);
const ACCOUNT = 'a'.repeat(64), MEMBER = 'b'.repeat(64), CLAIM = 'c'.repeat(64), PENDING = 'd'.repeat(64);
const INVITE = 'e'.repeat(64), NONCE = 'f'.repeat(64);
const CLUB = '12345678-1234-4234-8234-123456789abc', OTHER_CLUB = '22345678-1234-4234-8234-123456789abc';
const oldMember = `tennis-club:member:${LEGACY_API_ORIGIN}:${PAGES_BASE_URL}`;
const oldAccount = `tennis-club:account:${LEGACY_API_ORIGIN}:${PAGES_BASE_URL}`;
const newMember = `tennis-club:member:${API}:${PAGES_BASE_URL}`;
const newAccount = `tennis-club:account:${API}:${PAGES_BASE_URL}`;
const env = { TENNIS_API_BASE_URL: API, TENNIS_MIGRATION_FROM_ORIGIN: LEGACY_API_ORIGIN, TENNIS_MIGRATION_ID: ID };
const trustedConfig = getPagesConfig(env);
const manifest = { ...trustedConfig.credentialMigration, toApiOrigin: API, pageBaseUrl: PAGES_BASE_URL, credentialsPreserved: true };
const fullSource = () => ({
  [oldAccount]: ACCOUNT,
  [oldMember]: MEMBER,
  [oldMember + ':group:' + INVITE]: MEMBER,
  [oldMember + ':claims']: JSON.stringify([{ id: CLUB, name: '周末的群', nickname: '原来的我', isOwner: true, token: CLAIM }]),
  [oldMember + ':registration:' + OTHER_CLUB]: JSON.stringify({ clubId: OTHER_CLUB, nonce: NONCE, legacySession: PENDING, name: '待保存的群', nickname: '待保存的我', created: 1234 }),
  [oldMember + ':registration:broken']: '{broken',
  'unrelated:identity': 'do-not-read-or-move'
});
const source = await fs.readFile(new URL('../src/app.js', import.meta.url), 'utf8');
// Execute the actual browser bootstrap and transport, with an isolated storage
// and network boundary. No duplicate implementation or live service is used.
const bootstrap = source.slice(0, source.indexOf('const moods='));

function storage(entries = {}) {
  const values = { ...entries };
  Object.defineProperties(values, {
    getItem: { value: key => Object.hasOwn(values, key) ? values[key] : null },
    setItem: { value: (key, value) => { if (values.failWrites?.(key)) throw new Error('QuotaExceededError'); if (!values.skipWrites?.(key)) values[key] = String(value); } },
    removeItem: { value: key => { if (values.failRemovals?.(key)) throw new Error('SecurityError'); delete values[key]; } },
    failWrites: { value: null, writable: true },
    skipWrites: { value: null, writable: true },
    failRemovals: { value: null, writable: true }
  });
  return values;
}

function response(body, url, options = {}) {
  return { ok: options.ok !== false, url, redirected: !!options.redirected, json: async () => structuredClone(body) };
}

function frontend({ config = trustedConfig, entries = fullSource(), handler, hash = '' } = {}) {
  const localStorage = storage(entries), calls = [], location = { origin: new URL(PAGES_BASE_URL).origin, hash, assign() {}, replace() {} };
  const context = vm.createContext({
    window: { TENNIS_CONFIG: structuredClone(config) }, document: { querySelector: () => ({}) },
    localStorage, sessionStorage: storage(), location, history: { replaceState() {} },
    URL, URLSearchParams, Headers, AbortController, setTimeout, clearTimeout, crypto: webcrypto,
    fetch: async (input, options = {}) => {
      const url = String(input); calls.push({ url, ...options, headers: new Headers(options.headers) });
      if (handler) return handler(url, options, calls);
      if (url.endsWith('/api/migration')) return response(manifest, url);
      if (url.endsWith('/api/migration/validate')) return response({ ...manifest, acceptedProofIds: JSON.parse(options.body).proofs.map(proof => proof.proofId) }, url);
      return response({ account: null, clubs: [] }, url);
    }
  });
  vm.runInContext(bootstrap + '\nglobalThis.frontend={ensureCredentialMigration,apiFetch,state,migrationKey,markMigrationSignedOut,forgetAccountSession,forgetLegacySessions,forgetDeviceSessions,beginPagesLink};', context);
  return { ...context.frontend, localStorage, calls, context, location };
}

test('Pages build keeps the current production origin until an explicit replacement is configured', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tennis-pages-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const legacy = await buildPages({ output: path.join(directory, 'legacy'), env: {} });
  assert.equal(legacy.config.apiBaseUrl, LEGACY_API_ORIGIN);
  assert.equal(legacy.config.credentialMigration, undefined);
  const replacement = await buildPages({ output: path.join(directory, 'replacement'), env });
  const html = await fs.readFile(path.join(replacement.output, 'index.html'), 'utf8');
  const configJs = await fs.readFile(path.join(replacement.output, 'config.js'), 'utf8');
  assert.ok(html.includes(`connect-src 'self' ${API};`));
  assert.ok(!html.includes(LEGACY_API_ORIGIN));
  assert.ok(configJs.includes(PAGES_BASE_URL));
  assert.ok(configJs.includes('credentialMigration'));
  assert.match(html, /src="\.\/config\.js\?v=[a-f0-9]{12}"/);
});

test('build rejects private URL components, non-public hosts, old hosts and incomplete migration flags', () => {
  for (const value of ['', 'http://tennis-service.onrender.com', ' https://tennis-service.onrender.com',
    'https://user:private@tennis-service.onrender.com', API + '/api', API + '/?', API + '/#', API + '?secret=x',
    API + '#secret=x', API + ':443', API + ':8443', 'https://127.0.0.1', 'https://localhost',
    'https://service.internal', 'https://service.example', 'https://example.com', 'https://service.example.org',
    'https://tennis-service.onrender.com\\private']) {
    assert.throws(() => validateApiOrigin(value), Error, value);
  }
  assert.equal(validateApiOrigin(API + '/'), API);
  for (const value of [LEGACY_API_ORIGIN, 'https://chatgpt.site', 'https://other.chatgpt.site']) assert.throws(() => getPagesConfig({ TENNIS_API_BASE_URL: value }));
  for (const badEnv of [
    { TENNIS_API_BASE_URL: API, TENNIS_MIGRATION_ID: ID },
    { TENNIS_API_BASE_URL: API, TENNIS_MIGRATION_FROM_ORIGIN: LEGACY_API_ORIGIN },
    { TENNIS_API_BASE_URL: API, TENNIS_MIGRATION_FROM_ORIGIN: 'https://unrelated.onrender.com', TENNIS_MIGRATION_ID: ID },
    { TENNIS_MIGRATION_FROM_ORIGIN: LEGACY_API_ORIGIN, TENNIS_MIGRATION_ID: ID }
  ]) assert.throws(() => getPagesConfig(badEnv));
});

test('new API configuration without an explicit trusted migration never sends or copies old credentials', async () => {
  for (const config of [getPagesConfig({ TENNIS_API_BASE_URL: API }),
    { ...trustedConfig, credentialMigration: { ...trustedConfig.credentialMigration, fromApiOrigin: 'https://unrelated.onrender.com' } },
    { ...trustedConfig, credentialMigration: { ...trustedConfig.credentialMigration, migrationId: 'wrong' } }]) {
    const f = frontend({ config });
    await f.apiFetch('/api/auth/me');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].headers.get('X-Tennis-Session'), null);
    assert.equal(f.localStorage.getItem(newAccount), null);
    assert.equal(f.localStorage.getItem(newMember), null);
  }
});

test('manifest mismatches and redirects block credentials before validation and preserve all source keys', async () => {
  for (const [field, wrong] of Object.entries({ appId: 'other-app', schemaVersion: 3, migrationId: '0'.repeat(64),
    fromApiOrigin: API, toApiOrigin: LEGACY_API_ORIGIN, pageBaseUrl: 'https://other.github.io/', credentialsPreserved: false })) {
    const entries = fullSource(), f = frontend({ entries, handler: url => response({ ...manifest, [field]: wrong }, url) });
    await assert.rejects(f.apiFetch('/api/auth/me'), /原设备资料仍保留/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].body, undefined);
    assert.equal(f.calls[0].headers.get('Authorization'), null);
    assert.equal(f.calls[0].headers.get('X-Tennis-Session'), null);
    assert.equal(f.calls[0].credentials, 'omit');
    assert.equal(f.calls[0].redirect, 'error');
    for (const [key, value] of Object.entries(entries)) assert.equal(f.localStorage.getItem(key), value);
    assert.equal(f.localStorage.getItem(newAccount), null);
  }
  for (const failure of [
    url => response(manifest, url, { ok: false }),
    url => response(manifest, url, { redirected: true }),
    () => response(manifest, 'https://unrelated.onrender.com/api/migration'),
    () => { throw new TypeError('Failed to fetch'); },
    url => ({ ...response(manifest, url), json: async () => { throw new SyntaxError('Not JSON'); } })
  ]) {
    const f = frontend({ handler: failure });
    await assert.rejects(f.ensureCredentialMigration());
    assert.equal(f.calls.length, 1);
    assert.equal(f.localStorage.getItem(newAccount), null);
  }
});

test('successful validation migrates exact identities, claims and retry nonce without exposing user metadata', async () => {
  const entries = fullSource(), f = frontend({ entries, hash: 'g=' + INVITE });
  await Promise.all([f.ensureCredentialMigration(), f.ensureCredentialMigration()]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].body, undefined);
  const validated = f.calls[1], body = JSON.parse(validated.body);
  assert.equal(validated.credentials, 'omit');
  assert.equal(validated.redirect, 'error');
  assert.equal(validated.headers.get('X-Tennis-Session'), null);
  assert.equal(validated.headers.get('Authorization'), null);
  assert.deepEqual(body.proofs.map(p => p.kind), ['account', 'member', 'member', 'claim', 'registration']);
  assert.ok(!validated.body.includes('原来的我'));
  assert.ok(!validated.body.includes('待保存的群'));
  assert.ok(!validated.body.includes('created'));
  assert.equal(f.localStorage.getItem(newAccount), ACCOUNT);
  assert.equal(f.localStorage.getItem(newMember + ':group:' + INVITE), MEMBER);
  assert.equal(JSON.parse(f.localStorage.getItem(newMember + ':claims'))[0].id, CLUB);
  assert.equal(JSON.parse(f.localStorage.getItem(newMember + ':registration:' + OTHER_CLUB)).nonce, NONCE);
  assert.equal(f.state.accountSession, ACCOUNT);
  assert.equal(f.state.registrationAttempts[0].legacySession, PENDING);
  for (const [key, value] of Object.entries(entries)) assert.equal(f.localStorage.getItem(key), value);
  const marker = JSON.parse(f.localStorage.getItem(f.migrationKey));
  assert.equal(marker.status, 'complete');
  assert.deepEqual(Object.keys(marker).sort(), [...Object.keys(manifest), 'status'].sort());
  assert.ok(!JSON.stringify(marker).includes(ACCOUNT));
  await f.apiFetch('/api/auth/me');
  assert.equal(f.calls.at(-1).headers.get('X-Tennis-Session'), ACCOUNT);
  assert.equal(f.calls.at(-1).headers.get('Authorization'), null);
});

test('pending bound receipts migrate only when the server accepts the nonce-specific registration proof', async () => {
  const entries = fullSource(), f = frontend({ entries, handler: (url, options) => {
    if (url.endsWith('/api/migration')) return response(manifest, url);
    const acceptedProofIds = JSON.parse(options.body).proofs.filter(p => p.kind === 'registration').map(p => p.proofId);
    return response({ ...manifest, acceptedProofIds }, url);
  } });
  await f.ensureCredentialMigration();
  assert.equal(f.localStorage.getItem(newAccount), null);
  assert.equal(f.localStorage.getItem(newMember), null);
  const pending = JSON.parse(f.localStorage.getItem(newMember + ':registration:' + OTHER_CLUB));
  assert.equal(pending.nonce, NONCE);
  assert.equal(pending.legacySession, PENDING);
  assert.equal(f.localStorage.getItem(f.migrationKey), null);
  assert.equal(f.localStorage.getItem(oldAccount), ACCOUNT);
});

test('unknown or duplicate accepted proof IDs and redirected validation never commit credentials', async () => {
  for (const rejected of [
    (url, proofs) => response({ ...manifest, acceptedProofIds: ['not-requested'] }, url),
    (url, proofs) => response({ ...manifest, acceptedProofIds: [proofs[0].proofId, proofs[0].proofId] }, url),
    (url, proofs) => response({ ...manifest, acceptedProofIds: proofs.map(p => p.proofId) }, url, { redirected: true }),
    (url, proofs) => response({ ...manifest, acceptedProofIds: proofs.map(p => p.proofId) }, 'https://unrelated.onrender.com/api/migration/validate')
  ]) {
    const f = frontend({ handler: (url, options) => url.endsWith('/api/migration') ? response(manifest, url) : rejected(url, JSON.parse(options.body).proofs) });
    await assert.rejects(f.ensureCredentialMigration());
    assert.equal(f.localStorage.getItem(newAccount), null);
    assert.equal(f.localStorage.getItem(f.migrationKey), null);
    assert.equal(f.localStorage.getItem(oldAccount), ACCOUNT);
  }
});

test('existing target account and conflicting claims/nonce are never replaced', async () => {
  const existingAccount = '2'.repeat(64), existingClaim = '3'.repeat(64), existingNonce = '4'.repeat(64);
  const targetClaims = JSON.stringify([{ id: CLUB, nickname: '当前名片', token: existingClaim }]);
  const targetAttempt = JSON.stringify({ clubId: OTHER_CLUB, nonce: existingNonce, legacySession: PENDING });
  const f = frontend({ entries: { ...fullSource(), [newAccount]: existingAccount, [newMember + ':claims']: targetClaims, [newMember + ':registration:' + OTHER_CLUB]: targetAttempt } });
  await f.ensureCredentialMigration();
  const proofs = JSON.parse(f.calls[1].body).proofs;
  assert.ok(!proofs.some(p => p.kind === 'account' || p.kind === 'claim' || p.kind === 'registration'));
  assert.equal(f.localStorage.getItem(newAccount), existingAccount);
  assert.equal(f.localStorage.getItem(newMember + ':claims'), targetClaims);
  assert.equal(f.localStorage.getItem(newMember + ':registration:' + OTHER_CLUB), targetAttempt);
  assert.equal(f.localStorage.getItem(f.migrationKey), null);
});

test('storage write failure preserves source and allows safe retry without a completed marker', async () => {
  const f = frontend();
  f.localStorage.failWrites = key => key === newMember;
  await assert.rejects(f.ensureCredentialMigration());
  assert.equal(f.localStorage.getItem(f.migrationKey), null);
  assert.equal(f.localStorage.getItem(oldAccount), ACCOUNT);
  assert.equal(f.localStorage.getItem(oldMember), MEMBER);
  f.localStorage.failWrites = null;
  await f.ensureCredentialMigration();
  assert.equal(JSON.parse(f.localStorage.getItem(f.migrationKey)).status, 'complete');
  assert.equal(f.state.accountSession, ACCOUNT);
});

test('migration batches proof validation below the server body limit before ordinary API requests', async () => {
  const entries = {};
  for (let index = 0; index < 70; index++) entries[oldMember + ':group:' + index.toString(16).padStart(64, '0')] = MEMBER;
  const f = frontend({ entries, hash: '#g=' + '0'.repeat(64) });
  await f.apiFetch('/api/board');
  const batches = f.calls.filter(call => call.url.endsWith('/api/migration/validate'));
  assert.deepEqual(batches.map(call => JSON.parse(call.body).proofs.length), [32, 32, 6]);
  assert.ok(batches.every(call => Buffer.byteLength(call.body) < 20 * 1024));
  assert.equal(f.calls.at(-1).url, API + '/api/board');
  assert.equal(f.calls.at(-1).headers.get('X-Tennis-Session'), MEMBER);
  assert.equal(f.calls.at(-1).headers.get('Authorization'), 'Bearer ' + '0'.repeat(64));
  assert.equal(JSON.parse(f.localStorage.getItem(f.migrationKey)).status, 'complete');
});

test('a corrupt storage entry cannot hide or replace other valid claims and registration retries', async () => {
  const thirdClub = '32345678-1234-4234-8234-123456789abc';
  const validTargetClaim = { id: thirdClub, nickname: '现在的名片', token: '5'.repeat(64) };
  const f = frontend({ entries: { ...fullSource(),
    [oldMember + ':claims']: JSON.stringify([null, { id: CLUB, nickname: '原来的我', token: CLAIM }]),
    [newMember + ':claims']: JSON.stringify([null, validTargetClaim]),
    [newMember + ':registration:' + thirdClub]: '{corrupt'
  } });
  await f.ensureCredentialMigration();
  assert.deepEqual(Array.from(f.state.claims, claim => claim.id).sort(), [CLUB, thirdClub].sort());
  assert.equal(f.state.registrationAttempts.length, 1);
  assert.equal(f.state.registrationAttempts[0].nonce, NONCE);
  assert.equal(f.localStorage.getItem(newMember + ':registration:' + thirdClub), '{corrupt');
});

test('logout tombstone survives identity cleanup and stops old-source resurrection on reload', async () => {
  for (const partiallyAccepted of [false, true]) {
    const f = frontend({ handler: (url, options) => {
      if (url.endsWith('/api/migration')) return response(manifest, url);
      const proofs = JSON.parse(options.body).proofs;
      return response({ ...manifest, acceptedProofIds: proofs.filter(p => !partiallyAccepted || p.kind === 'account').map(p => p.proofId) }, url);
    } });
    await f.ensureCredentialMigration();
    f.markMigrationSignedOut(); f.forgetDeviceSessions();
    assert.equal(JSON.parse(f.localStorage.getItem(f.migrationKey)).status, 'signed-out');
    assert.equal(f.localStorage.getItem(oldAccount), null);
    const reloaded = frontend({ entries: { ...f.localStorage } });
    await reloaded.apiFetch('/api/auth/me');
    assert.equal(reloaded.calls.length, 1);
    assert.equal(reloaded.calls[0].headers.get('X-Tennis-Session'), null);
    assert.equal(reloaded.localStorage.getItem(newAccount), null);
    assert.equal(reloaded.localStorage.getItem(newMember), null);
    const futureConfig = getPagesConfig({ ...env, TENNIS_MIGRATION_ID: '6'.repeat(64) });
    const future = frontend({ config: futureConfig, entries: { ...f.localStorage } });
    await future.apiFetch('/api/auth/me');
    assert.equal(future.calls.length, 1);
    assert.equal(future.calls[0].headers.get('X-Tennis-Session'), null);
  }
});

test('logout removes only trusted source credentials when the browser rejects its tombstone', async () => {
  const f = frontend({ handler: (url, options) => {
    if (url.endsWith('/api/migration')) return response(manifest, url);
    return response({ ...manifest, acceptedProofIds: JSON.parse(options.body).proofs.filter(p => p.kind === 'account' || p.kind === 'member').map(p => p.proofId) }, url);
  } });
  await f.ensureCredentialMigration();
  assert.equal(f.localStorage.getItem(f.migrationKey), null);
  f.localStorage.failWrites = key => key === f.migrationKey;
  f.markMigrationSignedOut(); f.forgetDeviceSessions();
  for (const key of Object.keys(fullSource()).filter(key => key.startsWith(oldMember) || key === oldAccount)) assert.equal(f.localStorage.getItem(key), null);
  assert.equal(f.localStorage.getItem('unrelated:identity'), 'do-not-read-or-move');
  const reloaded = frontend({ entries: { ...f.localStorage } });
  await reloaded.apiFetch('/api/auth/me');
  assert.equal(reloaded.calls.length, 1);
  assert.equal(reloaded.calls[0].headers.get('X-Tennis-Session'), null);
});

test('silent tombstone write loss triggers source cleanup and cannot restore identity after reload', async () => {
  const f = frontend({ entries: { [oldAccount]: ACCOUNT } });
  await f.ensureCredentialMigration();
  f.localStorage.removeItem(f.migrationKey);
  f.localStorage.skipWrites = key => key === f.migrationKey;
  f.markMigrationSignedOut(); f.forgetDeviceSessions();
  assert.equal(f.localStorage.getItem(oldAccount), null);
  const reloaded = frontend({ entries: { ...f.localStorage } });
  await reloaded.apiFetch('/api/auth/me');
  assert.equal(reloaded.calls.length, 1);
  assert.equal(reloaded.calls[0].headers.get('X-Tennis-Session'), null);
});

test('logout reports an actual browser cleanup failure instead of claiming a durable logout', async () => {
  const f = frontend();
  await f.ensureCredentialMigration();
  f.localStorage.failWrites = key => key === f.migrationKey;
  f.localStorage.failRemovals = key => key.startsWith(oldMember);
  assert.throws(() => f.markMigrationSignedOut(), /浏览器未能清除旧身份/);
});

test('logout checks deletion of target legacy keys even after a durable tombstone was saved', async () => {
  const f = frontend();
  await f.ensureCredentialMigration();
  f.markMigrationSignedOut();
  f.localStorage.failRemovals = key => key === newMember;
  assert.throws(() => f.forgetDeviceSessions(), /浏览器未能清除保存的身份/);
  assert.equal(JSON.parse(f.localStorage.getItem(f.migrationKey)).status, 'signed-out');
  assert.equal(f.localStorage.getItem(newMember), MEMBER);
  assert.equal(f.localStorage.getItem(oldMember), null);
  f.localStorage.failRemovals = null;
  f.forgetDeviceSessions();
  assert.equal(f.localStorage.getItem(newMember), null);
  assert.equal(f.state.session, null);
  assert.equal(f.state.accountSession, null);
});

test('legacy identity bridge uses the configured API origin and keeps GitHub invitations unchanged', () => {
  const f = frontend({ config: getPagesConfig({ TENNIS_API_BASE_URL: API }), entries: {}, hash: '#g=' + INVITE });
  let destination;
  f.location.assign = value => { destination = value; };
  f.beginPagesLink();
  assert.equal(new URL(destination).origin, API);
  assert.equal(new URL(destination).hash.startsWith('#g=' + INVITE + '&connect=pages&state='), true);
  assert.ok(!destination.includes(LEGACY_API_ORIGIN));
});
