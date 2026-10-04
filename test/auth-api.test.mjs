import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import worker from '../src/worker.js';

const API = 'https://tennis-dazi-club-2026.divine-seal-5110.chatgpt.site';
const PAGES = 'https://zjwzkongqc.github.io';
const CODE_PATTERN = /^TC-(?:[A-F0-9]{8}-){4}[A-F0-9]{8}$/;
const WRONG_CODE = 'TC-00000000-00000000-00000000-00000000-00000000';
const nonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const hash = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');
const canonical = code => code.toLowerCase().replace(/[\s-]/g, '').replace(/^tc/, '');

import { fixture } from './helpers.mjs';

test('private recovery restores original owner, records, checkins, and avatar on another device', async t => {
  const f = fixture(t), club = await f.createClub();
  const recordId = crypto.randomUUID();
  const record = { id: recordId, playDate: '2026-01-20', minutes: 80, mood: '认真练球', note: '反手终于连续十拍', training: { projects: ['backhand'], content: '反手对拉', nextPlan: '反手接发球' } };
  assert.equal((await f.call('/api/records', { method: 'POST', ...club, body: record })).status, 201);
  assert.equal((await f.call('/api/checkins', { method: 'POST', ...club, body: {} })).status, 200);
  f.sqlite.prepare('UPDATE members SET avatar_key=? WHERE id=?').run('avatars/kept-original-photo', club.memberId);
  const saved = await f.enableRecovery(club);
  assert.equal(saved.account.displayName, 'Chris');
  const account = f.sqlite.prepare('SELECT * FROM accounts').get();
  assert.equal(account.recovery_hash, await hash(canonical(saved.recoveryCode)));
  assert.notEqual(account.recovery_hash, canonical(saved.recoveryCode));
  assert.equal(JSON.stringify(account).includes(saved.recoveryCode), false);
  assert.deepEqual(Object.keys(account).sort(), ['id', 'display_name', 'recovery_hash', 'created_at'].sort());
  const session = f.sqlite.prepare('SELECT session_hash,expires_at FROM account_sessions').get();
  assert.equal(session.session_hash, await hash(saved.accountToken));
  assert.notEqual(session.session_hash, saved.accountToken);
  assert.ok(session.expires_at > Date.now() + 179 * 86400000 && session.expires_at <= Date.now() + 180 * 86400000);
  const other = await f.login(saved.recoveryCode);
  assert.equal(other.status, 200);
  const restoredToken = other.data.sessionToken;
  assert.match(restoredToken, /^[a-f0-9]{64}$/);
  assert.notEqual(restoredToken, saved.accountToken);
  assert.equal(other.data.recoveryCode, undefined);
  assert.equal(other.data.legacySessionToken, undefined);
  const identity = await f.call('/api/auth/me', { accountToken: restoredToken });
  assert.equal(identity.data.account.id, saved.account.id);
  assert.equal(identity.data.account.displayName, 'Chris');
  assert.equal(identity.data.account.recovery_hash, undefined);
  assert.equal(identity.data.recoveryCode, undefined);
  assert.equal(identity.data.clubs.length, 1);
  assert.equal(identity.data.clubs[0].id, club.clubId);
  assert.equal(identity.data.clubs[0].isOwner, true);
  const board = await f.call(`/api/board?club=${club.clubId}`, { accountToken: restoredToken });
  assert.equal(board.status, 200);
  assert.equal(board.data.me, club.memberId);
  assert.equal(board.data.club.ownerId, club.memberId);
  assert.equal(board.data.records[0].id, recordId);
  assert.equal(board.data.members[0].hasAvatar, true);
  assert.equal(JSON.stringify(board.data).includes(saved.recoveryCode), false);
  const growth = await f.call(`/api/growth?club=${club.clubId}`, { accountToken: restoredToken });
  assert.equal(growth.data.summary.checkin_days, 1);
  assert.equal(growth.data.nextPlan.next_plan, '反手接发球');
  assert.equal((await f.call(`/api/records/${recordId}?club=${club.clubId}`, { method: 'PATCH', accountToken: restoredToken, body: { ...record, note: '换设备后继续复盘' } })).status, 200);
  assert.equal((await f.call(`/api/club?club=${club.clubId}`, { method: 'PATCH', accountToken: restoredToken, body: { name: '继续成长', slogan: '一起挥拍' } })).status, 200);
  assert.equal((await f.call('/api/board', club)).status, 401);
  assert.equal((await f.call('/api/growth', club)).status, 401);
  assert.equal((await f.call(`/api/records/${recordId}`, { method: 'DELETE', ...club })).status, 401);
  assert.equal((await f.call('/api/profile', { method: 'POST', ...club, body: { nickname: '旧 token 不应改名', bio: '' } })).status, 401);
  assert.equal(f.sqlite.prepare('SELECT nickname FROM members WHERE id=?').get(club.memberId).nickname, 'Chris');
});

test('normalization accepts recovery-code case, whitespace, separators, and optional prefix', async t => {
  const f = fixture(t), saved = await f.enableRecovery(await f.createClub());
  const variants = [saved.recoveryCode.toLowerCase(), saved.recoveryCode.replace(/^TC-/, ''), canonical(saved.recoveryCode), ` \n ${saved.recoveryCode.replaceAll('-', ' \t- ')} \n `];
  for (const code of variants) {
    const restored = await f.login(code);
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.equal(restored.data.account.id, saved.account.id);
    assert.equal(restored.data.recoveryCode, undefined);
  }
  const other = await f.enableRecovery(await f.createClub());
  assert.notEqual(other.recoveryCode, saved.recoveryCode);
  assert.notEqual(other.account.id, saved.account.id);
});

test('invalid formats and unknown recovery codes return the same authentication error', async t => {
  const f = fixture(t);
  let expected;
  for (const code of [WRONG_CODE, '', 'my-nickname', 'TC-1234', 'g'.repeat(40), null]) {
    const denied = await f.login(code);
    assert.equal(denied.status, 401);
    if (!expected) expected = denied.data;
    else assert.deepEqual(denied.data, expected);
    assert.equal(denied.data.recoveryCode, undefined);
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n, 0);
});

test('code rotation invalidates the old recovery code while active devices retain their sessions', async t => {
  const f = fixture(t), club = await f.createClub(), saved = await f.enableRecovery(club);
  const other = await f.login(saved.recoveryCode);
  const rotated = await f.call('/api/auth/recovery', { method: 'POST', accountToken: saved.accountToken, body: {} });
  assert.equal(rotated.status, 200, JSON.stringify(rotated.data));
  assert.match(rotated.data.recoveryCode, CODE_PATTERN);
  assert.notEqual(rotated.data.recoveryCode, saved.recoveryCode);
  assert.equal(rotated.data.sessionToken, undefined);
  assert.equal(f.sqlite.prepare('SELECT recovery_hash FROM accounts WHERE id=?').get(saved.account.id).recovery_hash, await hash(canonical(rotated.data.recoveryCode)));
  assert.equal((await f.login(saved.recoveryCode)).status, 401);
  const fresh = await f.login(rotated.data.recoveryCode);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.data.account.id, saved.account.id);
  for (const accountToken of [saved.accountToken, other.data.sessionToken]) assert.equal((await f.call(`/api/board?club=${club.clubId}`, { accountToken })).data.me, club.memberId);
  assert.equal((await f.call('/api/auth/recovery', { method: 'POST', body: {} })).status, 401);
});

test('logout revokes only its own session and expiry preserves member history', async t => {
  const f = fixture(t), club = await f.createClub(), saved = await f.enableRecovery(club), other = await f.login(saved.recoveryCode);
  const out = await f.call('/api/auth/logout', { method: 'POST', accountToken: saved.accountToken, body: {} });
  assert.equal(out.status, 200);
  assert.match(out.response.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal((await f.call('/api/auth/me', { accountToken: saved.accountToken })).data.account, null);
  assert.equal((await f.call(`/api/growth?club=${club.clubId}`, { accountToken: saved.accountToken })).status, 401);
  assert.equal((await f.call('/api/auth/me', { accountToken: other.data.sessionToken })).data.account.id, saved.account.id);
  f.sqlite.prepare('UPDATE account_sessions SET expires_at=?').run(Date.now() - 1000);
  assert.equal((await f.call('/api/auth/me', { accountToken: other.data.sessionToken })).data.account, null);
  assert.equal((await f.call(`/api/growth?club=${club.clubId}`, { accountToken: other.data.sessionToken })).status, 401);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT id FROM members').get().id, club.memberId);
});

test('binding requires exact legacy proof and cannot merge same-name or already-bound members', async t => {
  const f = fixture(t), first = await f.createClub('同名球友'), saved = await f.enableRecovery(first), second = await f.createClub('另一群的原名片');
  assert.equal((await f.call(`/api/board?club=${second.clubId}`, { accountToken: saved.accountToken })).status, 403);
  const bad = await f.call(`/api/auth/bind?club=${second.clubId}`, { method: 'POST', accountToken: saved.accountToken, body: { legacySessionToken: 'f'.repeat(64) } });
  assert.ok([401, 403].includes(bad.status));
  assert.equal(f.sqlite.prepare('SELECT account_id FROM members WHERE id=?').get(second.memberId).account_id, null);
  assert.equal((await f.call(`/api/auth/bind?club=${second.clubId}`, { method: 'POST', body: { legacySessionToken: second.token } })).status, 401);
  const bound = await f.call(`/api/auth/bind?club=${second.clubId}`, { method: 'POST', accountToken: saved.accountToken, body: { legacySessionToken: second.token } });
  assert.equal(bound.status, 200, JSON.stringify(bound.data));
  assert.equal(bound.data.id, second.memberId);
  assert.equal(bound.data.recoveryCode, undefined);
  assert.equal(bound.data.sessionToken, undefined);
  const restored = await f.call(`/api/board?club=${second.clubId}`, { accountToken: saved.accountToken });
  assert.equal(restored.data.me, second.memberId);
  assert.equal(restored.data.club.ownerId, second.memberId);
  assert.equal((await f.call(`/api/auth/bind?club=${second.clubId}`, { method: 'POST', accountToken: saved.accountToken, body: { legacySessionToken: second.token } })).status, 401);
  const duplicate = await f.createLegacyMember(first.clubId,'同名球友');
  assert.equal(duplicate.status, 201);
  assert.notEqual(duplicate.data.id, first.memberId);
  const recordId = crypto.randomUUID();
  assert.equal((await f.call('/api/records', { method: 'POST', invite: first.invite, token: duplicate.data.sessionToken, body: { id: recordId, playDate: '2026-01-20', minutes: 50, mood: '快乐拉球' } })).status, 201);
  const conflict = await f.call(`/api/auth/bind?club=${first.clubId}`, { method: 'POST', accountToken: saved.accountToken, body: { legacySessionToken: duplicate.data.sessionToken } });
  assert.equal(conflict.status, 409);
  assert.equal(f.sqlite.prepare('SELECT account_id FROM members WHERE id=?').get(duplicate.data.id).account_id, null);
  const own = await f.call(`/api/growth?club=${first.clubId}&memberId=${duplicate.data.id}`, { accountToken: saved.accountToken });
  assert.equal(own.data.summary.records, 0);
  assert.equal(own.data.records.length, 0);
  assert.equal((await f.call('/api/auth/me', { accountToken: saved.accountToken })).data.clubs.length, 2);
});

test('additional invites preserve old links without transferring owner identity', async t => {
  const f = fixture(t), club = await f.createClub(), saved = await f.enableRecovery(club);
  const issued = await f.call(`/api/invite?club=${club.clubId}`, { method: 'POST', accountToken: saved.accountToken, body: {} });
  assert.equal(issued.status, 200);
  assert.match(issued.data.invite, /^[a-f0-9]{64}$/);
  assert.notEqual(issued.data.invite, club.invite);
  for (const invite of [club.invite, issued.data.invite]) {
    const board = await f.call('/api/invitation', { invite });
    assert.equal(board.status, 200);
    assert.equal(board.data.club.id, club.clubId);
    assert.equal(board.data.joined, false);
    assert.equal((await f.call('/api/board',{invite})).status,401);
    assert.equal((await f.call('/api/invite', { method: 'POST', invite, body: {} })).status, 401);
    assert.equal((await f.call('/api/board', { invite, accountToken: saved.accountToken })).data.me, club.memberId);
  }
});

test('untrusted mutations are denied and account secrets cannot use the legacy export bridge', async t => {
  const f = fixture(t), club = await f.createClub(), saved = await f.enableRecovery(club);
  assert.deepEqual((await f.call('/api/auth/me')).data, { account: null, clubs: [] });
  for (const path of ['/api/auth/login', '/api/auth/register', '/api/auth/logout', '/api/auth/recovery', `/api/auth/bind?club=${club.clubId}`]) {
    const denied = await f.call(path, { method: 'POST', ...club, accountToken: saved.accountToken, origin: 'https://evil.example', body: { recoveryCode: saved.recoveryCode, legacySessionToken: club.token } });
    assert.equal(denied.status, 403);
    assert.equal(denied.response.headers.get('Access-Control-Allow-Origin'), null);
  }
  const login = await f.login(saved.recoveryCode, { origin: API });
  assert.equal(login.status, 200);
  assert.equal(login.data.sessionToken, undefined);
  assert.equal(login.data.recoveryCode, undefined);
  assert.match(login.response.headers.get('Set-Cookie'), /HttpOnly/);
  assert.match(login.response.headers.get('Set-Cookie'), /Max-Age=15552000/);
  const cookie = login.response.headers.get('Set-Cookie').split(';')[0];
  assert.equal((await f.call('/api/auth/me', { origin: API, headers: { Cookie: cookie } })).data.account.id, saved.account.id);
  const denied = await f.call('/api/pages-session', { method: 'POST', invite: club.invite, origin: API, headers: { Cookie: cookie } });
  assert.equal(denied.status, 403);
  assert.equal(denied.response.headers.get('Access-Control-Allow-Origin'), null);
});

test('new clubs and invite joins stay attached to the account across devices', async t => {
  const f = fixture(t), saved = await f.enableRecovery(await f.createClub());
  const created = await f.call('/api/clubs', { method: 'POST', accountToken: saved.accountToken, body: { name: '账号新建群', slogan: '', nickname: '新群群主' } });
  assert.equal(created.status, 201);
  assert.equal(created.data.sessionToken, undefined);
  const board = await f.call('/api/board', { invite: created.data.invite, accountToken: saved.accountToken });
  assert.equal(board.data.me, board.data.club.ownerId);
  const other = await f.createClub('另一个群主');
  const joined = await f.call('/api/profile', { method: 'POST', invite: other.invite, accountToken: saved.accountToken, body: { nickname: '账号加入的球友', bio: '' } });
  assert.equal(joined.status, 201);
  assert.notEqual(joined.data.id, other.memberId);
  const login = await f.login(saved.recoveryCode);
  assert.equal((await f.call('/api/auth/me', { accountToken: login.data.sessionToken })).data.clubs.length, 3);
  assert.equal((await f.call(`/api/board?club=${other.clubId}`, { accountToken: login.data.sessionToken })).data.me, joined.data.id);
  assert.equal((await f.call(`/api/club?club=${other.clubId}`, { method: 'PATCH', accountToken: login.data.sessionToken, body: { name: '不能改别人的群', slogan: '' } })).status, 403);
});

test('legacy root recovery enables its original member without reconstructing an invite', async t => {
  const f = fixture(t), club = await f.createClub();
  const identity = await f.call('/api/auth/me', { token: club.token });
  assert.equal(identity.data.account, null);
  assert.equal(identity.data.clubs[0].id, club.clubId);
  assert.equal((await f.call(`/api/board?club=${club.clubId}`, { token: club.token })).data.me, club.memberId);
  const enabled = await f.call(`/api/auth/register?club=${club.clubId}`, { method: 'POST', token: club.token, body: { registrationNonce: club.registrationNonce } });
  assert.equal(enabled.status, 200);
  assert.match(enabled.data.recoveryCode, CODE_PATTERN);
  const restored = await f.call(`/api/board?club=${club.clubId}`, { accountToken: enabled.data.sessionToken });
  assert.equal(restored.data.me, club.memberId);
  assert.equal(restored.data.club.ownerId, club.memberId);
  assert.equal((await f.call(`/api/auth/register?club=${club.clubId}`, { method: 'POST', body: { registrationNonce: club.registrationNonce } })).status, 401);
  assert.equal((await f.call(`/api/auth/register?club=${club.clubId}`, { method: 'POST', accountToken: enabled.data.sessionToken, body: { registrationNonce: nonce() } })).status, 409);
});

test('enabling recovery for one legacy group retains proof to bind another original group', async t => {
  const f = fixture(t), first = await f.createClub();
  const second = await f.createClub('第二群原群主',first.token);
  const enabled = await f.call('/api/auth/register', { method: 'POST', invite: first.invite, origin: API, headers: { Cookie: `tc_session=${first.token}` }, body: { registrationNonce: first.registrationNonce } });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.sessionToken, undefined);
  assert.match(enabled.data.recoveryCode, CODE_PATTERN);
  assert.equal(enabled.data.legacySessionToken, first.token);
  assert.equal(enabled.data.legacyClubs.length, 1);
  assert.equal(enabled.data.legacyClubs[0].id, second.clubId);
  assert.equal(enabled.data.legacyClubs[0].isOwner, true);
  const accountToken = enabled.response.headers.get('Set-Cookie').match(/tc_session=([a-f0-9]{64})/)[1];
  assert.equal((await f.call('/api/auth/me', { token: enabled.data.legacySessionToken })).data.clubs.length, 1);
  const bound = await f.call(`/api/auth/bind?club=${second.clubId}`, { method: 'POST', accountToken, body: { legacySessionToken: enabled.data.legacySessionToken } });
  assert.equal(bound.status, 200, JSON.stringify(bound.data));
  assert.equal(bound.data.recoveryCode, undefined);
  assert.equal(bound.data.legacySessionToken, undefined);
  const identity = await f.call('/api/auth/me', { accountToken });
  assert.equal(identity.data.clubs.length, 2);
  assert.equal(identity.data.legacySessionToken, undefined);
  for (const club of [first, second]) {
    const restored = await f.call(`/api/board?club=${club.clubId}`, { accountToken });
    assert.equal(restored.data.me, club.memberId);
    assert.equal(restored.data.club.ownerId, club.memberId);
    assert.equal((await f.call('/api/growth', { invite: club.invite, token: first.token })).status, 401);
  }
  assert.deepEqual((await f.call('/api/auth/me', { token: first.token })).data, { account: null, clubs: [] });
});

test('invalid-format failures persist by address and expire after the protection window', async t => {
  const f = fixture(t);
  for (let n = 0; n < 30; n++) assert.equal((await f.login(`invalid.${n}`, { address: '192.0.2.100' })).status, 401);
  assert.equal((await f.login(WRONG_CODE, { address: '192.0.2.100' })).status, 429);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM auth_failures').get().n, 1);
  assert.equal((await f.login(WRONG_CODE, { address: '192.0.2.101' })).status, 401);
  f.sqlite.prepare('UPDATE auth_failures SET window_start=?').run(Date.now() - 16 * 60 * 1000);
  assert.equal((await f.login(WRONG_CODE, { address: '192.0.2.100' })).status, 401);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM auth_failures').get().n, 1);
});

test('successful recovery cannot reset prior failures or grow rows for blocked random codes', async t => {
  const f = fixture(t), saved = await f.enableRecovery(await f.createClub());
  const options = { address: '192.0.2.120' };
  for (let n = 0; n < 29; n++) assert.equal((await f.login(`not-a-code.${n}`, options)).status, 401);
  assert.equal((await f.login(saved.recoveryCode, options)).status, 200);
  assert.equal((await f.login(WRONG_CODE, options)).status, 401);
  const before = f.sqlite.prepare('SELECT COUNT(*) AS n FROM auth_failures').get().n;
  for (let n = 0; n < 10; n++) assert.equal((await f.login(`random.blocked.${n}`, options)).status, 429);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM auth_failures').get().n, before);
  f.sqlite.prepare('INSERT INTO auth_failures(key,window_start,failures) VALUES(?,?,?)').run('ip:expired-fixture', Date.now() - 16 * 60 * 1000, 1);
  assert.equal((await f.login(WRONG_CODE, { address: '192.0.2.121' })).status, 401);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_failures WHERE key='ip:expired-fixture'").get().n, 0);
});

test('a failed first session rolls back recovery setup and leaves the original proof retryable', async t => {
  const f = fixture(t), club = await f.createClub(), recordId = crypto.randomUUID();
  assert.equal((await f.call('/api/records', { method: 'POST', ...club, body: { id: recordId, playDate: '2026-01-20', minutes: 60, mood: '认真练球', note: '原有成长记录' } })).status, 201);
  f.failOnce(/INSERT INTO account_sessions/);
  const failed = await f.call('/api/auth/register', { method: 'POST', ...club, body: { registrationNonce: club.registrationNonce } });
  assert.equal(failed.status, 503);
  assert.equal(failed.response.headers.get('Access-Control-Allow-Origin'), PAGES);
  assert.equal(failed.data.recoveryCode, undefined);
  assert.equal(failed.data.sessionToken, undefined);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM auth_registrations').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT account_id FROM members WHERE id=?').get(club.memberId).account_id, null);
  const board = await f.call('/api/board', club);
  assert.equal(board.data.me, club.memberId);
  assert.equal(board.data.records[0].id, recordId);
  f.failOnce(/INSERT INTO auth_registrations/);
  const receiptFailed = await f.call('/api/auth/register', { method: 'POST', ...club, body: { registrationNonce: club.registrationNonce } });
  assert.equal(receiptFailed.status, 503);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM auth_registrations').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT account_id FROM members WHERE id=?').get(club.memberId).account_id, null);
  const saved = await f.enableRecovery(club);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 1);
  assert.equal((await f.call(`/api/board?club=${club.clubId}`, { accountToken: saved.accountToken })).data.me, club.memberId);
});

test('login session write failure becomes a readable error and preserves existing sessions', async t => {
  const f = fixture(t), club = await f.createClub(), saved = await f.enableRecovery(club);
  f.failOnce(/INSERT INTO account_sessions/);
  const failed = await f.login(saved.recoveryCode);
  assert.equal(failed.status, 503);
  assert.equal(failed.response.headers.get('Access-Control-Allow-Origin'), PAGES);
  assert.equal(failed.data.sessionToken, undefined);
  assert.equal(failed.data.recoveryCode, undefined);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n, 1);
  assert.equal((await f.call(`/api/board?club=${club.clubId}`, { accountToken: saved.accountToken })).data.me, club.memberId);
  assert.equal((await f.login(saved.recoveryCode)).status, 200);
});

test('the same legacy proof and nonce safely recover a lost first response without duplicating identity', async t => {
  const f = fixture(t), club = await f.createClub(), saved = await f.enableRecovery(club);
  const receipt = f.sqlite.prepare('SELECT * FROM auth_registrations WHERE account_id=?').get(saved.account.id);
  assert.equal(receipt.club_id, club.clubId);
  assert.equal(receipt.legacy_hash, await hash(club.token));
  assert.equal(receipt.nonce_hash, await hash(club.registrationNonce));
  assert.ok(receipt.expires_at > Date.now());
  assert.equal(JSON.stringify(receipt).includes(club.token), false);
  assert.equal(JSON.stringify(receipt).includes(club.registrationNonce), false);
  const retry = await f.enableRecovery(club);
  assert.equal(retry.account.id, saved.account.id);
  assert.equal(retry.recoveryCode, saved.recoveryCode);
  assert.notEqual(retry.accountToken, saved.accountToken);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM members').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM auth_registrations').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n, 2);
  const wrongNonce = await f.call('/api/auth/register', { method: 'POST', ...club, body: { registrationNonce: nonce() } });
  assert.ok([401, 409].includes(wrongNonce.status));
  const wrongProof = await f.call('/api/auth/register', { method: 'POST', invite: club.invite, token: 'a'.repeat(64), body: { registrationNonce: club.registrationNonce } });
  assert.equal(wrongProof.status, 401);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n, 2);
  const restored = await f.call(`/api/board?club=${club.clubId}`, { accountToken: retry.accountToken });
  assert.equal(restored.data.me, club.memberId);
  assert.equal(restored.data.club.ownerId, club.memberId);
});

test('expired receipts and rotated recovery codes cannot restore an old bootstrap credential', async t => {
  const f = fixture(t), expiredClub = await f.createClub(), expired = await f.enableRecovery(expiredClub);
  f.sqlite.prepare('UPDATE auth_registrations SET expires_at=? WHERE account_id=?').run(Date.now() - 1000, expired.account.id);
  const expiredRetry = await f.call('/api/auth/register', { method: 'POST', ...expiredClub, body: { registrationNonce: expiredClub.registrationNonce } });
  assert.ok([401, 409].includes(expiredRetry.status));
  assert.equal(expiredRetry.data.recoveryCode, undefined);
  assert.equal((await f.login(expired.recoveryCode)).status, 200);
  const rotatedClub = await f.createClub(), saved = await f.enableRecovery(rotatedClub);
  const rotated = await f.call('/api/auth/recovery', { method: 'POST', accountToken: saved.accountToken, body: {} });
  assert.equal(rotated.status, 200);
  const before = f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n;
  const rotatedRetry = await f.call('/api/auth/register', { method: 'POST', ...rotatedClub, body: { registrationNonce: rotatedClub.registrationNonce } });
  assert.ok([401, 409].includes(rotatedRetry.status));
  assert.equal(rotatedRetry.data.recoveryCode, undefined);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n, before);
  assert.equal(f.sqlite.prepare('SELECT recovery_hash FROM accounts WHERE id=?').get(saved.account.id).recovery_hash, await hash(canonical(rotated.data.recoveryCode)));
  assert.equal((await f.login(saved.recoveryCode)).status, 401);
  assert.equal((await f.login(rotated.data.recoveryCode)).status, 200);
});

test('recovery setup requires a valid hidden nonce before writing any account state', async t => {
  const f = fixture(t), club = await f.createClub();
  for (const registrationNonce of [undefined, '', 'A'.repeat(64), 'b'.repeat(63), 'g'.repeat(64)]) {
    const denied = await f.call('/api/auth/register', { method: 'POST', ...club, body: registrationNonce === undefined ? {} : { registrationNonce } });
    assert.equal(denied.status, 400);
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM auth_registrations').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT account_id FROM members WHERE id=?').get(club.memberId).account_id, null);
  assert.match((await f.enableRecovery(club)).recoveryCode, CODE_PATTERN);
});

test('an original-site backup cookie recovers a lost body only for the same account, proof, and nonce', async t => {
  const f = fixture(t), club = await f.createClub();
  const enabled = await f.call('/api/auth/register', { method: 'POST', invite: club.invite, origin: API, headers: { Cookie: `tc_session=${club.token}` }, body: { registrationNonce: club.registrationNonce } });
  assert.equal(enabled.status, 200);
  const cookies = enabled.response.headers.get('Set-Cookie');
  const accountToken = cookies.match(/tc_session=([a-f0-9]{64})/)[1];
  assert.match(cookies, /tc_registration_legacy=[a-f0-9]{64}; Path=\/api\/auth\/register; HttpOnly; SameSite=Lax; Max-Age=3600; Secure/);
  const backup = `tc_registration_legacy=${club.token}`;
  const currentAndBackup = `tc_session=${accountToken}; ${backup}`;
  const recovered = await f.call('/api/auth/register', { method: 'POST', invite: club.invite, origin: API, headers: { Cookie: currentAndBackup }, body: { registrationNonce: club.registrationNonce } });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
  assert.equal(recovered.data.account.id, enabled.data.account.id);
  assert.equal(recovered.data.recoveryCode, enabled.data.recoveryCode);
  assert.equal(recovered.data.sessionToken, undefined);
  const other = await f.enableRecovery(await f.createClub());
  const deniedCookies = [
    { cookie: `tc_session=${other.accountToken}; ${backup}`, registrationNonce: club.registrationNonce },
    { cookie: `tc_session=${accountToken}; tc_registration_legacy=${'e'.repeat(64)}`, registrationNonce: club.registrationNonce },
    { cookie: currentAndBackup, registrationNonce: nonce() },
    { cookie: `tc_session=${accountToken}`, registrationNonce: club.registrationNonce }
  ];
  for (const item of deniedCookies) {
    const denied = await f.call('/api/auth/register', { method: 'POST', invite: club.invite, origin: API, headers: { Cookie: item.cookie }, body: { registrationNonce: item.registrationNonce } });
    assert.ok([401, 409].includes(denied.status));
    assert.equal(denied.data.recoveryCode, undefined);
  }
  assert.deepEqual((await f.call('/api/auth/me', { origin: API, headers: { Cookie: backup } })).data, { account: null, clubs: [] });
  assert.equal((await f.call('/api/board', { invite: club.invite, origin: API, headers: { Cookie: backup } })).status, 401);
  assert.equal((await f.call('/api/growth', { invite: club.invite, origin: API, headers: { Cookie: backup } })).status, 401);
  const bridge = await f.call('/api/pages-session', { method: 'POST', invite: club.invite, origin: API, headers: { Cookie: backup } });
  assert.equal(bridge.status, 401);
  const logout = await f.call('/api/auth/logout', { method: 'POST', origin: API, headers: { Cookie: currentAndBackup }, body: {} });
  assert.equal(logout.status, 200);
  assert.match(logout.response.headers.get('Set-Cookie'), /tc_session=;[^,]*Max-Age=0/);
  assert.match(logout.response.headers.get('Set-Cookie'), /tc_registration_legacy=;[^,]*Max-Age=0/);
});

test('rotation between login verification and session insertion rejects the old recovery code', async t => {
  const f = fixture(t), club = await f.createClub(), saved = await f.enableRecovery(club);
  const rotatedHash = await hash('1'.repeat(40));
  let interleaved = false;
  f.beforeOnce(/INSERT INTO account_sessions/, sqlite => {
    interleaved = true;
    sqlite.prepare('UPDATE accounts SET recovery_hash=? WHERE id=?').run(rotatedHash, saved.account.id);
  });
  const denied = await f.login(saved.recoveryCode);
  assert.equal(interleaved, true);
  assert.equal(denied.status, 401);
  assert.equal(denied.data.sessionToken, undefined);
  assert.equal(denied.data.recoveryCode, undefined);
  assert.equal(denied.response.headers.get('Set-Cookie'), null);
  assert.equal(JSON.stringify(denied.data).includes(saved.recoveryCode), false);
  assert.equal(JSON.stringify(denied.data).includes(saved.accountToken), false);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT recovery_hash FROM accounts WHERE id=?').get(saved.account.id).recovery_hash, rotatedHash);
  assert.equal((await f.call(`/api/board?club=${club.clubId}`, { accountToken: saved.accountToken })).data.me, club.memberId);
});

test('receipt expiry between lookup and session insertion prevents recovery of a lost response', async t => {
  const f = fixture(t), club = await f.createClub(), saved = await f.enableRecovery(club);
  let interleaved = false;
  f.beforeOnce(/INSERT INTO account_sessions/, sqlite => {
    interleaved = true;
    sqlite.prepare('UPDATE auth_registrations SET expires_at=? WHERE account_id=?').run(Date.now() - 1000, saved.account.id);
  });
  const denied = await f.call('/api/auth/register', { method: 'POST', ...club, body: { registrationNonce: club.registrationNonce } });
  assert.equal(interleaved, true);
  assert.equal(denied.status, 401);
  assert.equal(denied.data.sessionToken, undefined);
  assert.equal(denied.data.recoveryCode, undefined);
  assert.equal(denied.response.headers.get('Set-Cookie'), null);
  assert.equal(JSON.stringify(denied.data).includes(saved.recoveryCode), false);
  assert.equal(JSON.stringify(denied.data).includes(saved.accountToken), false);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n, 1);
  assert.equal((await f.call(`/api/board?club=${club.clubId}`, { accountToken: saved.accountToken })).data.me, club.memberId);
});

test('code rotation during account-cookie and backup-cookie recovery cannot mint a session or return the old code', async t => {
  const f = fixture(t), club = await f.createClub(), saved = await f.enableRecovery(club);
  const rotatedHash = await hash('2'.repeat(40));
  let interleaved = false;
  f.beforeOnce(/INSERT INTO account_sessions/, sqlite => {
    interleaved = true;
    sqlite.prepare('UPDATE accounts SET recovery_hash=? WHERE id=?').run(rotatedHash, saved.account.id);
  });
  const denied = await f.call('/api/auth/register', {
    method: 'POST', invite: club.invite, origin: API,
    headers: { Cookie: `tc_session=${saved.accountToken}; tc_registration_legacy=${club.token}` },
    body: { registrationNonce: club.registrationNonce }
  });
  assert.equal(interleaved, true);
  assert.equal(denied.status, 401);
  assert.equal(denied.data.sessionToken, undefined);
  assert.equal(denied.data.recoveryCode, undefined);
  assert.equal(denied.response.headers.get('Set-Cookie'), null);
  assert.equal(JSON.stringify(denied.data).includes(saved.recoveryCode), false);
  assert.equal(JSON.stringify(denied.data).includes(saved.accountToken), false);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT recovery_hash FROM accounts WHERE id=?').get(saved.account.id).recovery_hash, rotatedHash);
  assert.equal((await f.call('/api/auth/me', { accountToken: saved.accountToken })).data.account.id, saved.account.id);
});
