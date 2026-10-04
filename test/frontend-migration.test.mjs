import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { buildPages, getPagesConfig, validateApiOrigin, LEGACY_API_ORIGIN, PAGES_BASE_URL, SUPABASE_API_PREFIX } from '../scripts/build-pages.mjs';

const API = 'https://tennis-service.onrender.com';
const SUPABASE_API = 'https://tennisfixtureabcdefg.supabase.co';
const ID = '1'.repeat(64);
const ACCOUNT = 'a'.repeat(64), MEMBER = 'b'.repeat(64), CLAIM = 'c'.repeat(64), PENDING = 'd'.repeat(64);
const INVITE = 'e'.repeat(64), NONCE = 'f'.repeat(64);
const FRESH_INVITE = '7'.repeat(64);
const CLUB = '12345678-1234-4234-8234-123456789abc', OTHER_CLUB = '22345678-1234-4234-8234-123456789abc';
const oldMember = `tennis-club:member:${LEGACY_API_ORIGIN}:${PAGES_BASE_URL}`;
const oldAccount = `tennis-club:account:${LEGACY_API_ORIGIN}:${PAGES_BASE_URL}`;
const newMember = `tennis-club:member:${API}:${PAGES_BASE_URL}`;
const newAccount = `tennis-club:account:${API}:${PAGES_BASE_URL}`;
const env = { TENNIS_API_BASE_URL: API, TENNIS_MIGRATION_FROM_ORIGIN: LEGACY_API_ORIGIN, TENNIS_MIGRATION_ID: ID };
const trustedConfig = getPagesConfig(env);
const supabaseConfig = getPagesConfig({ ...env, TENNIS_API_BASE_URL: SUPABASE_API, TENNIS_API_PATH_PREFIX: SUPABASE_API_PREFIX });
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
const clubSource = await fs.readFile(new URL('../src/club-ui.js', import.meta.url), 'utf8');
// Execute the actual browser bootstrap and transport, with an isolated storage
// and network boundary. No duplicate implementation or live service is used.
const bootstrap = source.slice(0, source.indexOf('const moods='));
const actualFunction = (start, end, text = source) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
const browserFunctions = actualFunction('function esc(', '\nfunction hours(') +
  actualFunction('async function loadAvatars(', '\nconst tabs=') +
  actualFunction('function joinBanner(', '\nfunction badge(') +
  actualFunction('function shareUrl(', '\nasync function openInvite(') +
  actualFunction('async function loadRecordPhotos(', '\nasync function photoBlob(', clubSource) +
  actualFunction('async function loadPublicCard(', '\nfunction renderPublicCard(', clubSource);

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

function frontend({ config = trustedConfig, entries = fullSource(), handler, hash = '', sessionEntries = {} } = {}) {
  const localStorage = storage(entries), calls = [], replacements = [], location = { origin: new URL(PAGES_BASE_URL).origin, hash, assign() {}, replace() {} };
  const currentManifest = { ...config.credentialMigration, toApiOrigin: config.apiBaseUrl, pageBaseUrl: config.pageBaseUrl, credentialsPreserved: true };
  const context = vm.createContext({
    window: { TENNIS_CONFIG: structuredClone(config) }, document: { querySelector: () => ({}), querySelectorAll: () => [] },
    localStorage, sessionStorage: storage(sessionEntries), location, history: { replaceState: (state, title, url) => replacements.push(url) },
    URL, URLSearchParams, Headers, AbortController, setTimeout, clearTimeout, crypto: webcrypto,
    fetch: async (input, options = {}) => {
      const url = String(input); calls.push({ url, ...options, headers: new Headers(options.headers) });
      if (handler) return handler(url, options, calls);
      if (url.endsWith('/api/migration')) return response(currentManifest, url);
      if (url.endsWith('/api/migration/validate')) return response({ ...currentManifest, acceptedProofIds: JSON.parse(options.body).proofs.map(proof => proof.proofId) }, url);
      return response({ account: null, clubs: [] }, url);
    }
  });
  vm.runInContext(bootstrap + browserFunctions + '\nglobalThis.frontend={ensureCredentialMigration,apiFetch,apiUrl,state,migrationKey,markMigrationSignedOut,forgetAccountSession,forgetLegacySessions,forgetDeviceSessions,beginPagesLink,showPagesLink,joinBanner,shareUrl,loadAvatars,loadRecordPhotos,loadPublicCard,SERVICE_BASE};', context);
  return { ...context.frontend, localStorage, calls, replacements, context, location };
}

test('Pages build keeps the current production origin until an explicit replacement is configured', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tennis-pages-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const legacy = await buildPages({ output: path.join(directory, 'legacy'), env: {} });
  assert.equal(legacy.config.apiBaseUrl, LEGACY_API_ORIGIN);
  assert.equal(legacy.config.apiPathPrefix, '');
  assert.equal(legacy.config.credentialMigration, undefined);
  const replacement = await buildPages({ output: path.join(directory, 'replacement'), env });
  const html = await fs.readFile(path.join(replacement.output, 'index.html'), 'utf8');
  const configJs = await fs.readFile(path.join(replacement.output, 'config.js'), 'utf8');
  assert.ok(html.includes(`connect-src 'self' ${API};`));
  assert.ok(!html.includes(LEGACY_API_ORIGIN));
  assert.ok(configJs.includes(PAGES_BASE_URL));
  assert.ok(configJs.includes('credentialMigration'));
  assert.equal(replacement.config.credentialMigration.schemaVersion, 5);
  assert.match(html, /src="\.\/club-ui\.js\?v=[a-f0-9]{12}"/);
  assert.equal(await fs.readFile(path.join(replacement.output, 'club-ui.js'), 'utf8'), clubSource);
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
    { ...trustedConfig, credentialMigration: { ...trustedConfig.credentialMigration, migrationId: 'wrong' } },
    { ...trustedConfig, credentialMigration: { ...trustedConfig.credentialMigration, schemaVersion: 4 } }]) {
    const f = frontend({ config });
    await f.apiFetch('/api/auth/me');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].headers.get('X-Tennis-Session'), null);
    assert.equal(f.localStorage.getItem(newAccount), null);
    assert.equal(f.localStorage.getItem(newMember), null);
  }
});

test('manifest mismatches and redirects block credentials before validation and preserve all source keys', async () => {
  for (const [field, wrong] of Object.entries({ appId: 'other-app', schemaVersion: 4, migrationId: '0'.repeat(64),
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

test('Supabase prefix is a fixed separate setting; config and CSP keep a pure API origin', async t => {
  for (const prefix of ['/', '/api', '/functions/v1/other', SUPABASE_API_PREFIX + '/', SUPABASE_API_PREFIX + '?token=x',
    SUPABASE_API_PREFIX + '#token=x', 'https://other.supabase.co', '//other.supabase.co', null, 0]) {
    assert.throws(() => getPagesConfig({ ...env, TENNIS_API_PATH_PREFIX: prefix }), /TENNIS_API_PATH_PREFIX/);
    let networkCalls = 0;
    assert.throws(() => frontend({ config: { ...trustedConfig, apiPathPrefix: prefix }, handler: () => { networkCalls++; } }), /账户服务路径配置无效/);
    assert.equal(networkCalls, 0);
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tennis-supabase-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const built = await buildPages({ output: directory, env: { ...env, TENNIS_API_BASE_URL: SUPABASE_API, TENNIS_API_PATH_PREFIX: SUPABASE_API_PREFIX } });
  const html = await fs.readFile(path.join(directory, 'index.html'), 'utf8');
  const configJs = await fs.readFile(path.join(directory, 'config.js'), 'utf8');
  assert.equal(built.config.apiBaseUrl, SUPABASE_API);
  assert.equal(built.config.apiPathPrefix, SUPABASE_API_PREFIX);
  assert.ok(html.includes(`connect-src 'self' ${SUPABASE_API};`));
  assert.ok(!html.includes(SUPABASE_API + SUPABASE_API_PREFIX));
  assert.ok(configJs.includes('"apiPathPrefix": "/functions/v1/tennis-api"'));
  assert.equal(built.config.pageBaseUrl, PAGES_BASE_URL);
});

test('prefixed migration, auth, records, growth and avatar transport retain paths, proof scope and GitHub sharing', async () => {
  const tuple = { ...supabaseConfig.credentialMigration, toApiOrigin: SUPABASE_API, pageBaseUrl: PAGES_BASE_URL, credentialsPreserved: true };
  const f = frontend({ config: supabaseConfig, hash: '#g=' + INVITE, handler: (url, options) => {
    if (url.endsWith('/api/migration')) return response(tuple, url);
    if (url.endsWith('/api/migration/validate')) return response({ ...tuple, acceptedProofIds: JSON.parse(options.body).proofs.map(p => p.proofId) }, url);
    if (url.endsWith('/api/avatar/' + CLUB)) return { ...response({}, url), blob: async () => new Blob(['fixture avatar'], { type: 'image/jpeg' }) };
    return response({}, url);
  } });
  await f.apiFetch('/api/auth/me');
  assert.equal(f.calls[0].url, SUPABASE_API + SUPABASE_API_PREFIX + '/api/migration');
  assert.equal(f.calls[0].headers.get('X-Tennis-Session'), null);
  assert.equal(f.calls[0].headers.get('Authorization'), null);
  assert.equal(f.calls[0].body, undefined);
  assert.equal(f.calls[1].url, SUPABASE_API + SUPABASE_API_PREFIX + '/api/migration/validate');
  assert.equal(f.calls[1].headers.get('X-Tennis-Session'), null);
  assert.equal(f.calls[1].headers.get('Authorization'), null);
  assert.equal(f.calls[1].credentials, 'omit');
  assert.equal(f.calls[1].redirect, 'error');
  assert.equal(f.calls[2].headers.get('X-Tennis-Session'), ACCOUNT);
  assert.equal(f.calls[2].headers.get('Authorization'), null);
  const targetMember = `tennis-club:member:${SUPABASE_API}:${PAGES_BASE_URL}`;
  const targetAccount = `tennis-club:account:${SUPABASE_API}:${PAGES_BASE_URL}`;
  assert.equal(f.localStorage.getItem(targetAccount), ACCOUNT);
  assert.equal(JSON.parse(f.localStorage.getItem(targetMember + ':registration:' + OTHER_CLUB)).nonce, NONCE);
  assert.equal(f.localStorage.getItem(oldAccount), ACCOUNT);
  assert.ok(Object.keys(f.localStorage).every(key => !key.includes(SUPABASE_API + SUPABASE_API_PREFIX)));

  const routes = ['/api/auth/me', '/api/auth/login', '/api/auth/signup', '/api/auth/credentials', '/api/auth/logout', '/api/auth/recovery', `/api/auth/bind?club=${CLUB}`,
    '/api/clubs', '/api/board', '/api/profile', '/api/avatar', '/api/records', `/api/records/${CLUB}`, '/api/checkins',
    '/api/growth?month=2026-10&page=2', '/api/training-plan', '/api/cheers', '/api/culture', '/api/club', '/api/invite',
    '/api/invitation', '/api/ratings?memberId=' + CLUB, '/api/share', '/api/photos/' + CLUB, `/api/records/${CLUB}/photos`,
    '/api/admin', '/api/export', '/api/members/' + CLUB, '/api/members/' + CLUB + '/profile', '/api/invites/' + CLUB];
  for (const route of routes) {
    await f.apiFetch(route);
    const call = f.calls.at(-1);
    assert.equal(call.url, SUPABASE_API + SUPABASE_API_PREFIX + route);
    assert.equal(call.headers.get('X-Tennis-Session'), ACCOUNT);
    const pathname = new URL(route, SUPABASE_API).pathname;
    assert.equal(call.headers.get('Authorization'), /^\/api\/auth\/(me|login|signup|credentials|logout|recovery|bind)$/.test(pathname) ? null : 'Bearer ' + INVITE);
  }
  await f.apiFetch(`/api/auth/register?club=${OTHER_CLUB}`, { method: 'POST', legacySession: PENDING, body: JSON.stringify({ registrationNonce: NONCE }) });
  assert.equal(f.calls.at(-1).headers.get('X-Tennis-Session'), PENDING);
  assert.equal(f.calls.at(-1).url, SUPABASE_API + SUPABASE_API_PREFIX + '/api/auth/register?club=' + OTHER_CLUB);
  f.state.board = { club: { id: CLUB }, me: null, members: [{ id: CLUB, nickname: '原来的我', hasAvatar: true, avatarVersion: 17 }] };
  await f.loadAvatars();
  assert.equal(f.calls.at(-1).url, SUPABASE_API + SUPABASE_API_PREFIX + '/api/avatar/' + CLUB);
  assert.equal(f.state.avatars.get(CLUB)?.version, 17);
  URL.revokeObjectURL(f.state.avatars.get(CLUB).url);
  assert.equal(f.shareUrl(), null);
  f.state.shareInvite = FRESH_INVITE;
  assert.equal(f.shareUrl(), PAGES_BASE_URL + '#g=' + FRESH_INVITE);
  assert.equal(f.SERVICE_BASE, SUPABASE_API + SUPABASE_API_PREFIX);

  f.state.invite = null; f.state.club = CLUB;
  await f.apiFetch('/api/board');
  assert.equal(f.calls.at(-1).url, SUPABASE_API + SUPABASE_API_PREFIX + '/api/board?club=' + CLUB);
  await f.apiFetch('/api/auth/recovery');
  assert.equal(f.calls.at(-1).url, SUPABASE_API + SUPABASE_API_PREFIX + '/api/auth/recovery');
  assert.ok(f.calls.every(call => call.url.startsWith(SUPABASE_API + SUPABASE_API_PREFIX + '/api/')));
  assert.ok(f.calls.every(call => call.credentials === 'omit' && call.redirect === 'error'));
  assert.throws(() => f.apiUrl('https://unrelated.supabase.co/api/board'), /请求路径无效/);
  assert.throws(() => f.apiUrl('/functions/v1/other/api/board'), /请求路径无效/);
});

test('prefixed manifest mismatch blocks all source proofs at the chosen function path', async () => {
  const f = frontend({ config: supabaseConfig, handler: url => response({ ...manifest, toApiOrigin: SUPABASE_API, migrationId: '0'.repeat(64) }, url) });
  await assert.rejects(f.apiFetch('/api/board'), /原设备资料仍保留/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, SUPABASE_API + SUPABASE_API_PREFIX + '/api/migration');
  assert.equal(f.calls[0].body, undefined);
  assert.equal(f.calls[0].headers.get('X-Tennis-Session'), null);
  assert.equal(f.localStorage.getItem(oldAccount), ACCOUNT);
  assert.equal(f.localStorage.getItem(`tennis-club:account:${SUPABASE_API}:${PAGES_BASE_URL}`), null);
});

test('function mode has no cookie-page bridge or redirect loop and retains recovery login', () => {
  const f = frontend({ config: supabaseConfig, entries: {}, hash: '#g=' + INVITE });
  f.state.board = { club: { id: CLUB }, me: null };
  assert.ok(!f.joinBanner().includes('data-action="link-pages"'));
  assert.ok(f.joinBanner().includes('data-action="login"'));
  let recoveryOpened = 0, redirects = 0;
  f.context.openRecoveryLogin = () => { recoveryOpened++; };
  f.location.assign = () => { redirects++; };
  f.beginPagesLink();
  assert.equal(recoveryOpened, 1);
  assert.equal(redirects, 0);
  assert.equal(f.calls.length, 0);
  f.state.linkIntent = NONCE;
  f.showPagesLink();
  assert.equal(f.state.linkShown, false);
  assert.equal(f.shareUrl(), null);
  f.state.shareInvite = FRESH_INVITE;
  assert.equal(f.shareUrl(), PAGES_BASE_URL + '#g=' + FRESH_INVITE);

  const memberKey = `tennis-club:member:${SUPABASE_API}:${PAGES_BASE_URL}`;
  const returned = frontend({ config: supabaseConfig, entries: {}, hash: `#g=${INVITE}&session=${MEMBER}&state=${NONCE}`,
    sessionEntries: { [memberKey + ':link']: JSON.stringify({ nonce: NONCE, invite: INVITE, created: Date.now() }) } });
  assert.equal(returned.state.session, null);
  assert.equal(returned.localStorage.getItem(memberKey), null);
  assert.equal(returned.state.linkFailed, true);
  assert.deepEqual(returned.replacements, [PAGES_BASE_URL + '#g=' + INVITE]);
  assert.equal(returned.calls.length, 0);
});

test('schema 5 public player cards and avatars use anonymous prefixed requests without migrating private identity', async () => {
  const publicCard = { nickname: '公开的球员卡', bio: '愿意公开的一句话', hasAvatar: true, rating: { month: '2026-10', forehand: 0, backhand: null } };
  const f = frontend({ config: supabaseConfig, hash: '#p=' + INVITE, handler: url =>
    url.endsWith('/api/public/card/' + INVITE) ? response(publicCard, url) : { ...response({}, url), blob: async () => new Blob(['public-avatar']) } });
  let renders = 0;
  f.context.renderPublicCard = () => { renders++; };
  await f.loadPublicCard();
  assert.equal(renders, 2);
  assert.deepEqual(f.calls.map(call => call.url), [
    SUPABASE_API + SUPABASE_API_PREFIX + '/api/public/card/' + INVITE,
    SUPABASE_API + SUPABASE_API_PREFIX + '/api/public/avatar/' + INVITE
  ]);
  assert.ok(f.calls.every(call => call.headers.get('Authorization') === null && call.headers.get('X-Tennis-Session') === null));
  assert.ok(f.calls.every(call => call.credentials === 'omit' && call.redirect === 'error' && call.cache === 'no-store' && call.body === undefined));
  assert.equal(f.state.publicCard.nickname, publicCard.nickname);
  assert.equal(f.state.publicCard.rating.forehand, 0);
  assert.equal(f.state.publicCard.rating.backhand, null);
  assert.equal(f.localStorage.getItem(oldAccount), ACCOUNT);
  assert.equal(f.localStorage.getItem(`tennis-club:account:${SUPABASE_API}:${PAGES_BASE_URL}`), null);
  assert.equal(f.state.accountSession, null);
  assert.ok(f.state.avatars.has('public'));
  URL.revokeObjectURL(f.state.avatars.get('public').url);
});

test('schema 5 private record photos use prefixed member transport and cache the returned image', async () => {
  const photoId = '32345678-1234-4234-8234-123456789abc';
  const targetAccount = `tennis-club:account:${SUPABASE_API}:${PAGES_BASE_URL}`;
  const image = { dataset: { photoId }, src: null };
  const f = frontend({ config: supabaseConfig, entries: { [targetAccount]: ACCOUNT }, hash: '#c=' + CLUB,
    handler: url => ({ ...response({}, url), blob: async () => new Blob(['private-photo']) }) });
  f.context.document.querySelectorAll = selector => ['img[data-photo-id]', `img[data-photo-id="${photoId}"]`].includes(selector) ? [image] : [];
  await f.loadRecordPhotos();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, SUPABASE_API + SUPABASE_API_PREFIX + '/api/photos/' + photoId + '?club=' + CLUB);
  assert.equal(f.calls[0].headers.get('X-Tennis-Session'), ACCOUNT);
  assert.equal(f.calls[0].headers.get('Authorization'), null);
  assert.equal(f.calls[0].redirect, 'error');
  assert.equal(image.src, f.state.avatars.get('photo:' + photoId).url);
  URL.revokeObjectURL(image.src);
});
