import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { handleWishes } from '../deploy/fresh/wishes.mjs';
import { ACTIVE_NOTEBOOK } from '../deploy/fresh/settings.mjs';
import { ACTIVE_NOTEBOOK_ID, ACTIVE_NOTEBOOK_NAME, NOTEBOOK_POLICY_VERSION, createNotebookPolicy } from '../deploy/fresh/notebook.mjs';
import { wishFixture } from './wishes-helper.mjs';

const API = 'https://kvbxmvwtblwibhesnleh.supabase.co', ORIGIN = 'https://zjwzkongqc.github.io';
const hash = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');
const nonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const record = (minutes = 60) => ({ id: crypto.randomUUID(), playDate: '2026-01-20', minutes, mood: '认真练球', note: '保留训练历史' });

function policyCaller(f, activeClubId) {
  const policy = createNotebookPolicy({ activeClubId });
  const call = async (path, { method = 'GET', token, accountToken, invite, body, raw, origin = ORIGIN, headers: extra = {}, env = f.env } = {}) => {
    const headers = { ...extra };
    if (origin) headers.Origin = origin;
    if (token || accountToken) headers['X-Tennis-Session'] = accountToken || token;
    if (invite) headers.Authorization = `Bearer ${invite}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const request = new Request(API + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const response = await policy.after(request, await policy.before(request, env) ?? await handleWishes(request, env) ?? await worker.fetch(request, env));
    const type = response.headers.get('Content-Type') || '';
    return { response, status: response.status, data: type.includes('application/json') ? await response.json() : await response.text() };
  };
  return { call, policy };
}

async function setup(t) {
  const f = wishFixture(t), active = await f.createClub('活跃记录本球友'), archive = await f.createClub('归档记录本球友');
  Object.assign(active, await f.enableRecovery(active));
  Object.assign(archive, await f.enableRecovery(archive));
  for (const person of [active, archive]) {
    const saved = record(person === active ? 60 : 90);
    assert.equal((await f.call(`/api/records?club=${person.clubId}`, { method: 'POST', accountToken: person.accountToken, body: saved })).status, 201);
    person.record = saved;
  }
  return { f, active, archive, ...policyCaller(f, active.clubId) };
}

function groupSnapshot(f, clubId) {
  return JSON.stringify(Object.fromEntries(['clubs', 'members', 'records', 'checkins', 'culture', 'audit_events', 'club_invites'].map(table => [table,
    f.sqlite.prepare(`SELECT * FROM ${table} WHERE ${table === 'clubs' ? 'id' : 'club_id'}=? ORDER BY rowid`).all(clubId)
  ])));
}

test('fresh policy uses the configured active notebook and never creates a new one', async t => {
  assert.equal(ACTIVE_NOTEBOOK_ID, ACTIVE_NOTEBOOK.id);
  assert.equal(ACTIVE_NOTEBOOK_NAME, ACTIVE_NOTEBOOK.name);
  assert.equal(NOTEBOOK_POLICY_VERSION, 'single-notebook-v1');
  assert.throws(() => createNotebookPolicy({ activeClubId: 'not-an-id' }), TypeError);
  const { f, active, archive, call } = await setup(t);
  const before = f.sqlite.prepare('SELECT * FROM clubs ORDER BY id').all();
  for (const auth of [{}, active, archive]) {
    const response = await call('/api/clubs', { ...auth, method: 'POST', body: { name: '不能创建', nickname: '原名片', slogan: '' } });
    assert.equal(response.status, 403);
    assert.equal(response.data.code, 'NOTEBOOK_CREATION_DISABLED');
    assert.equal(response.response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal(response.response.headers.get('Cache-Control'), 'no-store');
  }
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM clubs ORDER BY id').all(), before);
});

test('auth/me hides archived memberships without changing account fields or granting the primary notebook', async t => {
  const { f, active, archive, call } = await setup(t);
  const anotherArchive = await f.createClub('同一账号的归档名片');
  assert.equal((await f.call(`/api/auth/bind?club=${anotherArchive.clubId}`, { method: 'POST', accountToken: active.accountToken, body: { legacySessionToken: anotherArchive.token } })).status, 200);
  const original = await f.call('/api/auth/me', active), filtered = await call('/api/auth/me', active);
  assert.equal(original.data.clubs.length, 2);
  assert.deepEqual(filtered.data, { ...original.data, clubs: original.data.clubs.filter(item => item.id === active.clubId) });
  assert.equal(filtered.response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const archivedUser = await call('/api/auth/me', archive);
  assert.deepEqual(archivedUser.data.clubs, []);
  assert.equal(archivedUser.data.account.id, archive.account.id);
  assert.equal((await call(`/api/board?club=${active.clubId}`, { accountToken: archive.accountToken })).status, 403);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM members WHERE club_id=? AND account_id=?').get(active.clubId, archive.account.id).n, 0);
});

test('all archived group reads and writes are blocked without modifying archived rows', async t => {
  const { f, active, archive, call } = await setup(t), before = groupSnapshot(f, archive.clubId);
  for (const [path, method] of [
    ['/api/board', 'GET'], ['/api/growth', 'GET'], ['/api/export', 'GET'], ['/api/invitation', 'GET'],
    ['/api/records', 'POST'], [`/api/records/${archive.record.id}`, 'PATCH'], [`/api/records/${archive.record.id}`, 'DELETE'],
    ['/api/checkins', 'POST'], ['/api/profile', 'POST'], ['/api/avatar', 'POST'], ['/api/ratings', 'POST'],
    ['/api/cheers', 'POST'], ['/api/culture', 'POST'], ['/api/invite', 'POST'], ['/api/share', 'POST'],
    [`/api/members/${archive.memberId}`, 'DELETE'], [`/api/records/${archive.record.id}/photos`, 'POST']
  ]) {
    const result = await call(`${path}?club=${archive.clubId}`, { method, accountToken: archive.accountToken, ...(method !== 'GET' ? { body: {} } : {}) });
    assert.equal(result.status, 410, `${method} ${path}`);
    assert.equal(result.data.code, 'NOTEBOOK_ARCHIVED');
  }
  assert.equal((await call(`/api/board?club=${archive.clubId}`, { accountToken: active.accountToken, invite: active.invite })).status, 410);
  assert.equal((await call(`/api/board?club=${active.clubId}&club=${archive.clubId}`, active)).status, 410);
  assert.equal(groupSnapshot(f, archive.clubId), before);
});

test('archived original and additional invitation links are blocked including mixed active targets and expired links', async t => {
  const { f, active, archive, call } = await setup(t);
  const extra = await f.call(`/api/invite?club=${archive.clubId}`, { method: 'POST', accountToken: archive.accountToken, body: {} });
  assert.equal(extra.status, 200);
  for (const invite of [archive.invite, extra.data.invite]) {
    for (const path of ['/api/invitation', '/api/board', `/api/board?club=${active.clubId}`]) {
      assert.equal((await call(path, { accountToken: active.accountToken, invite })).status, 410, path);
    }
    assert.equal((await call('/api/profile', { method: 'POST', accountToken: active.accountToken, invite, body: { nickname: '不能加入' } })).status, 410);
  }
  f.sqlite.prepare('UPDATE clubs SET invite_revoked_at=? WHERE id=?').run(new Date().toISOString(), archive.clubId);
  f.sqlite.prepare('UPDATE club_invites SET expires_at=? WHERE club_id=?').run(Date.now() - 1, archive.clubId);
  assert.equal((await call('/api/invitation', { invite: archive.invite })).status, 410);
  assert.equal((await call('/api/invitation', { invite: extra.data.invite })).status, 410);
});

test('active invitations preserve existing membership, invalid invite, revoked invite and private API checks', async t => {
  const { f, active, archive, call } = await setup(t);
  assert.equal((await call('/api/invitation', { invite: active.invite })).status, 200);
  assert.equal((await call('/api/board', { invite: active.invite })).status, 401);
  assert.equal((await call(`/api/board?club=${active.clubId}`)).status, 401);
  assert.equal((await call(`/api/board?club=${active.clubId}`, { accountToken: archive.accountToken })).status, 403);
  assert.equal((await call('/api/board', active)).status, 200);
  assert.equal((await call('/api/invitation', { invite: '0'.repeat(64) })).status, 404);
  assert.equal((await call('/api/invitation', { headers: { Authorization: 'Bearer invalid' } })).status, 401);
  const joined = await call('/api/profile', { method: 'POST', accountToken: archive.accountToken, invite: active.invite, body: { nickname: '经邀请加入', bio: '' } });
  assert.equal(joined.status, 201);
  assert.equal((await call(`/api/board?club=${active.clubId}`, { accountToken: archive.accountToken })).status, 200);
  f.sqlite.prepare('UPDATE clubs SET invite_revoked_at=? WHERE id=?').run(new Date().toISOString(), active.clubId);
  assert.equal((await call('/api/invitation', { invite: active.invite })).status, 404);
  assert.equal((await call(`/api/board?club=${active.clubId}`, { accountToken: active.accountToken })).status, 200);
});

test('archived register and bind cannot claim archived legacy members from either target channel', async t => {
  const { f, active, archive, call } = await setup(t), legacy = await f.createLegacyMember(archive.clubId);
  const memberBefore = f.sqlite.prepare('SELECT * FROM members WHERE id=?').get(legacy.data.id);
  for (const query of ['', `?club=${archive.clubId}`, `?club=${active.clubId}`]) {
    assert.equal((await call('/api/auth/register' + query, { method: 'POST', token: legacy.data.sessionToken, invite: archive.invite, body: { registrationNonce: nonce() } })).status, 410);
  }
  assert.equal((await call(`/api/auth/register?club=${archive.clubId}`, { method: 'POST', token: legacy.data.sessionToken, body: { registrationNonce: nonce() } })).status, 410);
  assert.equal((await call(`/api/auth/bind?club=${archive.clubId}`, { method: 'POST', accountToken: active.accountToken, body: { legacySessionToken: legacy.data.sessionToken } })).status, 410);
  assert.equal((await call(`/api/auth/bind?club=${active.clubId}`, { method: 'POST', accountToken: active.accountToken, body: { legacySessionToken: legacy.data.sessionToken, club: archive.clubId } })).status, 401);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM members WHERE id=?').get(legacy.data.id), memberBefore);
});

test('active legacy registration and retry preserve recovery and filter only archived claim listings', async t => {
  const f = wishFixture(t), active = await f.createClub('原来的名片'), archive = await f.createClub('同浏览器归档名片', active.token), { call } = policyCaller(f, active.clubId);
  const data = { method: 'POST', invite: active.invite, token: active.token, body: { registrationNonce: active.registrationNonce } };
  const first = await call('/api/auth/register', data);
  assert.equal(first.status, 200);
  assert.deepEqual(first.data.legacyClubs, []);
  assert.equal(first.data.legacySessionToken, active.token);
  assert.match(first.data.recoveryCode, /^TC-/);
  assert.match(first.data.sessionToken, /^[a-f0-9]{64}$/);
  assert.equal(f.sqlite.prepare('SELECT account_id FROM members WHERE id=?').get(active.memberId).account_id, first.data.account.id);
  assert.equal(f.sqlite.prepare('SELECT account_id FROM members WHERE id=?').get(archive.memberId).account_id, null);
  const resumed = await call('/api/auth/register', data);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.account.id, first.data.account.id);
  assert.equal(resumed.data.recoveryCode, first.data.recoveryCode);
  assert.deepEqual(resumed.data.legacyClubs, []);
});

test('archived accounts can recover, read private wishes and retain historical value despite stale group parameters', async t => {
  const { f, archive, call } = await setup(t);
  const saved = await call(`/api/wishes?club=${archive.clubId}`, { method: 'POST', ...archive, body: { id: crypto.randomUUID(), name: '自己的心愿', targetCents: 300000 } });
  assert.equal(saved.status, 201);
  const login = await call(`/api/auth/login?club=${archive.clubId}`, { method: 'POST', invite: archive.invite, body: { recoveryCode: archive.recoveryCode } });
  assert.equal(login.status, 200);
  assert.equal(login.data.account.id, archive.account.id);
  const wishes = await call(`/api/wishes?club=${archive.clubId}`, { accountToken: login.data.sessionToken, invite: archive.invite });
  assert.equal(wishes.status, 200);
  assert.equal(wishes.data.totalMinutes, 90);
  assert.equal(wishes.data.totalValueCents, 22500);
  assert.equal(wishes.data.wishes[0].id, saved.data.wish.id);
  assert.equal((await call(`/api/wishes?club=${archive.clubId}`, { invite: archive.invite })).status, 401);
  assert.equal((await call(`/api/auth/recovery?club=${archive.clubId}`, { method: 'POST', accountToken: login.data.sessionToken, body: {} })).status, 200);
  assert.equal((await call(`/api/auth/logout?club=${archive.clubId}`, { method: 'POST', accountToken: login.data.sessionToken, body: {} })).status, 200);
  assert.equal((await call('/api/wishes', { accountToken: login.data.sessionToken })).status, 401);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM training_wishes').get().n, 1);
});

test('new account onboarding creates only an identity until an active invitation is used', async t => {
  const { f, active, call } = await setup(t);
  const started = await call('/api/auth/start', { method: 'POST', body: { nickname: '新球友', startNonce: nonce() } });
  assert.equal(started.status, 201);
  const accountToken = started.data.sessionToken;
  assert.deepEqual((await call('/api/auth/me', { accountToken })).data.clubs, []);
  assert.equal((await call(`/api/board?club=${active.clubId}`, { accountToken })).status, 403);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM members WHERE account_id=?').get(started.data.account.id).n, 0);
  assert.equal((await call('/api/profile', { method: 'POST', accountToken, invite: active.invite, body: { nickname: '新球友' } })).status, 201);
  assert.equal((await call('/api/auth/me', { accountToken })).data.clubs[0].id, active.clubId);
});

test('preflights, public readonly cards and allowed request bodies keep existing behavior', async t => {
  const { f, active, archive, call, policy } = await setup(t);
  const shared = await f.call(`/api/share?club=${archive.clubId}`, { method: 'POST', accountToken: archive.accountToken, body: { enabled: true } });
  assert.equal(shared.status, 200);
  assert.equal((await call(`/api/public/card/${shared.data.token}?club=${archive.clubId}`)).status, 200);
  const headers = { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-tennis-session' };
  assert.equal((await call('/api/clubs', { method: 'OPTIONS', headers })).status, 204);
  assert.equal((await call('/api/clubs', { method: 'OPTIONS', headers, origin: 'https://evil.example' })).status, 403);
  const input = record(25), request = new Request(API + `/api/records?club=${active.clubId}`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Tennis-Session': active.accountToken, Authorization: `Bearer ${active.invite}` }, body: JSON.stringify(input) });
  assert.equal(await policy.before(request, f.env), null);
  assert.equal(request.bodyUsed, false);
  const response = await worker.fetch(request, f.env);
  assert.equal(response.status, 201);
  assert.equal(f.sqlite.prepare('SELECT minutes FROM records WHERE id=?').get(input.id).minutes, 25);
});

test('policy database lookup failures fail closed and return private CORS errors', async t => {
  const { active, call } = await setup(t);
  const failure = await call('/api/board', { ...active, env: { DB: { prepare() { throw new Error('private database credential'); } } } });
  assert.equal(failure.status, 503);
  assert.equal(JSON.stringify(failure.data).includes('credential'), false);
  assert.equal(failure.response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const denied = await call('/api/clubs', { method: 'POST', origin: 'https://evil.example', body: {} });
  assert.equal(denied.status, 403);
  assert.equal(denied.response.headers.get('Access-Control-Allow-Origin'), null);
});

test('response filtering retains every unrelated field and header and never rewrites errors or other APIs', async () => {
  const policy = createNotebookPolicy(), request = new Request(API + '/api/auth/me');
  const source = { account: { id: 'account', displayName: '名片', hasEmail: false }, clubs: [{ id: ACTIVE_NOTEBOOK_ID, name: '当前记录本' }, { id: crypto.randomUUID(), name: '归档' }], extra: { preserve: true } };
  const response = new Response(JSON.stringify(source), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Custom-Header': 'keep', 'Set-Cookie': 'keep=existing-auth', 'Content-Length': '999', ETag: 'old-body' } });
  const filtered = await policy.after(request, response);
  assert.deepEqual(await filtered.json(), { ...source, clubs: [source.clubs[0]] });
  assert.equal(filtered.headers.get('X-Custom-Header'), 'keep');
  assert.equal(filtered.headers.get('Set-Cookie'), 'keep=existing-auth');
  assert.equal(filtered.headers.get('Content-Length'), null);
  assert.equal(filtered.headers.get('ETag'), null);
  const error = new Response('{"error":"original"}', { status: 401, headers: { 'Content-Type': 'application/json' } });
  assert.equal(await policy.after(request, error), error);
  const untouched = new Response('{"clubs":[]}', { headers: { 'Content-Type': 'application/json' } });
  assert.equal(await policy.after(new Request(API + '/api/wishes'), untouched), untouched);
});
