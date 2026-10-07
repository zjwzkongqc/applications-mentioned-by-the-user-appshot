import test from 'node:test';
import assert from 'node:assert/strict';
import { wishFixture } from './wishes-helper.mjs';

const record = (minutes = 60) => ({ id: crypto.randomUUID(), playDate: '2026-01-20', minutes, mood: '认真练球', note: '训练心愿真实时长测试' });
const wish = (overrides = {}) => ({ id: crypto.randomUUID(), name: '喜欢的新球拍', targetCents: 300000, ...overrides });
const png = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0,73,72,68,82]);
const jpeg = Uint8Array.from([255,216,255,224,0,16,74,70,73,70,0,1]);
const webp = Uint8Array.from([82,73,70,70,8,0,0,0,87,69,66,80]);
async function person(f, nickname = '球友') {
  const club = await f.createClub(nickname), saved = await f.enableRecovery(club);
  return { ...club, ...saved };
}
async function addRecord(f, person, data) {
  const result = await f.call(`/api/records?club=${person.clubId}`, { method: 'POST', accountToken: person.accountToken, body: data });
  assert.equal(result.status, 201, JSON.stringify(result.data));
}
async function addWish(f, person, data = wish()) {
  const result = await f.wishCall('/api/wishes', { method: 'POST', ...person, body: data });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.wish;
}

test('personal training totals span own groups, exclude other accounts/check-ins and retain minute precision', async t => {
  const f = wishFixture(t), owner = await person(f), other = await person(f, '另一位球友');
  const empty = await f.wishCall('/api/wishes', owner);
  assert.deepEqual(empty.data, { rateCentsPerHour: 15000, totalMinutes: 0, totalValueCents: 0, wishes: [] });
  const secondClub = await f.createClub('另一本训练本');
  const bound = await f.call(`/api/auth/bind?club=${secondClub.clubId}`, { method: 'POST', accountToken: owner.accountToken, body: { legacySessionToken: secondClub.token } });
  assert.equal(bound.status, 200);
  await addRecord(f, owner, record(60));
  await addRecord(f, { ...secondClub, accountToken: owner.accountToken }, record(30));
  await addRecord(f, owner, record(1));
  await addRecord(f, other, record(120));
  assert.equal((await f.call(`/api/checkins?club=${owner.clubId}`, { method: 'POST', accountToken: owner.accountToken, body: {} })).status, 200);
  // Query-string account/member IDs and group invitations cannot redirect scope.
  const total = await f.wishCall(`/api/wishes?account_id=${other.account.id}&memberId=${other.memberId}&club=${other.clubId}`, owner);
  assert.equal(total.data.totalMinutes, 91);
  assert.equal(total.data.totalValueCents, 22750);
  assert.equal((await f.wishCall('/api/wishes', other)).data.totalValueCents, 30000);
  f.sqlite.prepare('UPDATE members SET removed_at=? WHERE id=?').run(new Date().toISOString(), secondClub.memberId);
  assert.equal((await f.wishCall('/api/wishes', owner)).data.totalMinutes, 91, 'historical personal time survives leaving a group');
});

test('editing and deleting real training records recomputes equivalent value; fulfilling wishes never spends it', async t => {
  const f = wishFixture(t), owner = await person(f), training = record(600);
  await addRecord(f, owner, training);
  const first = await addWish(f, owner), second = await addWish(f, owner, wish({ name: '下一双网球鞋', targetCents: 100000 }));
  assert.equal((await f.wishCall('/api/wishes', owner)).data.totalValueCents, 150000);
  const fulfilled = await f.wishCall(`/api/wishes/${first.id}`, { method: 'PATCH', ...owner, body: { fulfilled: true } });
  assert.equal(fulfilled.status, 200);
  assert.ok(fulfilled.data.wish.fulfilledAt);
  const unchanged = await f.wishCall('/api/wishes', owner);
  assert.equal(unchanged.data.totalValueCents, 150000);
  assert.equal(unchanged.data.wishes.find(item => item.id === second.id).fulfilledAt, null);
  assert.equal((await f.call(`/api/records/${training.id}?club=${owner.clubId}`, { method: 'PATCH', accountToken: owner.accountToken, body: { ...training, minutes: 900 } })).status, 200);
  assert.equal((await f.wishCall('/api/wishes', owner)).data.totalValueCents, 225000);
  assert.equal((await f.call(`/api/records/${training.id}?club=${owner.clubId}`, { method: 'DELETE', accountToken: owner.accountToken })).status, 200);
  const removed = await f.wishCall('/api/wishes', owner);
  assert.equal(removed.data.totalMinutes, 0);
  assert.equal(removed.data.totalValueCents, 0);
  assert.equal(removed.data.wishes.length, 2);
  assert.equal(removed.data.wishes.find(item => item.id === first.id).fulfilledAt, fulfilled.data.wish.fulfilledAt);
});

test('wish creation retries are idempotent, edits are independent and fulfilled state can be undone', async t => {
  const f = wishFixture(t), owner = await person(f), input = wish({ name: '  想去看的比赛  ', targetCents: 12345 });
  const created = await addWish(f, owner, input);
  assert.equal(created.name, '想去看的比赛');
  assert.equal(created.imageUrl, null);
  const retry = await f.wishCall('/api/wishes', { method: 'POST', ...owner, body: input });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.wish.id, created.id);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM training_wishes').get().n, 1);
  assert.equal((await f.wishCall('/api/wishes', { method: 'POST', ...owner, body: { ...input, targetCents: 999 } })).status, 409);
  const updated = await f.wishCall(`/api/wishes/${created.id}`, { method: 'PATCH', ...owner, body: { name: '决赛门票', targetCents: 45678 } });
  assert.equal(updated.data.wish.name, '决赛门票');
  assert.equal(updated.data.wish.targetCents, 45678);
  const completed = await f.wishCall(`/api/wishes/${created.id}`, { method: 'PATCH', ...owner, body: { fulfilled: true } });
  const repeated = await f.wishCall(`/api/wishes/${created.id}`, { method: 'PATCH', ...owner, body: { fulfilled: true } });
  assert.equal(repeated.data.wish.fulfilledAt, completed.data.wish.fulfilledAt);
  const undone = await f.wishCall(`/api/wishes/${created.id}`, { method: 'PATCH', ...owner, body: { fulfilled: false } });
  assert.equal(undone.data.wish.fulfilledAt, null);
  assert.equal(undone.data.wish.name, '决赛门票');
  assert.equal(undone.data.wish.targetCents, 45678);
  assert.equal((await f.wishCall(`/api/wishes/${created.id}`, { method: 'DELETE', ...owner })).status, 200);
  assert.equal((await f.wishCall('/api/wishes', owner)).data.wishes.length, 0);
});

test('another account, including a group owner, cannot read, overwrite, fulfill, delete or upload a private wish', async t => {
  const f = wishFixture(t), owner = await person(f, '心愿主人'), outsider = await person(f, '另一群主');
  const joined = await f.call('/api/profile', { method: 'POST', invite: outsider.invite, accountToken: owner.accountToken, body: { nickname: '加入另一群', bio: '' } });
  assert.equal(joined.status, 201);
  const saved = await addWish(f, owner), path = `/api/wishes/${saved.id}`;
  assert.deepEqual((await f.wishCall('/api/wishes', outsider)).data.wishes, []);
  for (const body of [{ name: '不能冒名修改' }, { targetCents: 1 }, { fulfilled: true }]) {
    assert.equal((await f.wishCall(path, { method: 'PATCH', ...outsider, body })).status, 404);
  }
  assert.equal((await f.wishCall(path, { method: 'DELETE', ...outsider })).status, 404);
  assert.equal((await f.wishCall(path + '/image', outsider)).status, 404);
  assert.equal((await f.wishCall(path + '/image', { method: 'POST', ...outsider, raw: png })).status, 404);
  assert.equal((await f.wishCall(path + '/image', { method: 'DELETE', ...outsider })).status, 404);
  assert.equal((await f.wishCall('/api/wishes', { method: 'POST', ...outsider, body: { id: saved.id, name: saved.name, targetCents: saved.targetCents } })).status, 409);
  assert.equal((await f.wishCall('/api/wishes', owner)).data.wishes[0].name, saved.name);
  const row = f.sqlite.prepare('SELECT * FROM training_wishes WHERE id=?').get(saved.id);
  for (const privateKey of ['account_id', 'image_key', 'recovery_hash', 'session_hash']) assert.equal(Object.hasOwn(saved, privateKey), false);
  assert.equal(row.account_id, owner.account.id);
});

test('missing, forged, legacy, expired and revoked sessions never gain personal access; recovery restores the same wishes', async t => {
  const f = wishFixture(t), owner = await person(f), saved = await addWish(f, owner);
  for (const options of [{}, { token: '0'.repeat(64) }, { token: owner.token }, { token: owner.account.id }, { headers: { Cookie: `tc_session=${owner.accountToken}` } }, { headers: { Authorization: `Bearer ${owner.invite}` } }]) {
    assert.equal((await f.wishCall('/api/wishes', options)).status, 401);
    assert.equal((await f.wishCall(`/api/wishes/${saved.id}`, { ...options, method: 'DELETE' })).status, 401);
  }
  const freshLogin = await f.login(owner.recoveryCode);
  assert.equal(freshLogin.status, 200);
  assert.equal((await f.wishCall('/api/wishes', { accountToken: freshLogin.data.sessionToken })).data.wishes[0].id, saved.id);
  await f.call('/api/auth/logout', { method: 'POST', accountToken: owner.accountToken, body: {} });
  assert.equal((await f.wishCall('/api/wishes', owner)).status, 401);
  f.sqlite.prepare('UPDATE account_sessions SET expires_at=?').run(Date.now() - 1);
  assert.equal((await f.wishCall('/api/wishes', { accountToken: freshLogin.data.sessionToken })).status, 401);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM training_wishes').get().n, 1);
});

test('wish fields enforce precise bounded cents and text; protected state cannot be submitted as a field', async t => {
  const f = wishFixture(t), owner = await person(f);
  for (const value of [0, -1, 1.1, '15000', null, 100000001, Number.MAX_SAFE_INTEGER]) {
    assert.equal((await f.wishCall('/api/wishes', { method: 'POST', ...owner, body: wish({ targetCents: value }) })).status, 400);
  }
  for (const name of ['', '   ', null, '字'.repeat(61)]) assert.equal((await f.wishCall('/api/wishes', { method: 'POST', ...owner, body: wish({ name }) })).status, 400);
  for (const input of [wish({ id: '../nope' }), wish({ account_id: owner.account.id }), wish({ image_key: 'private/object' }), wish({ fulfilled: true }), [], null]) {
    assert.equal((await f.wishCall('/api/wishes', { method: 'POST', ...owner, body: input })).status, 400);
  }
  assert.equal((await f.wishCall('/api/wishes', { method: 'POST', ...owner, raw: '{', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await f.wishCall('/api/wishes', { method: 'POST', ...owner, raw: '{}' })).status, 415);
  assert.equal((await f.wishCall('/api/wishes', { method: 'POST', ...owner, raw: 'x'.repeat(20001), headers: { 'Content-Type': 'application/json' } })).status, 413);
  const smallest = await addWish(f, owner, wish({ name: '🎾'.repeat(60), targetCents: 1 }));
  assert.equal(smallest.targetCents, 1);
  const largest = await addWish(f, owner, wish({ targetCents: 100000000 }));
  for (const body of [{}, { fulfilled: 'true' }, { account_id: 'elsewhere' }, { targetCents: -100 }, { name: '' }]) assert.equal((await f.wishCall(`/api/wishes/${largest.id}`, { method: 'PATCH', ...owner, body })).status, 400);
  assert.equal((await f.wishCall('/api/wishes', owner)).data.wishes.length, 2);
});

test('wish images remain private, validate bytes, replace cleanly and disappear with their wish', async t => {
  const f = wishFixture(t), owner = await person(f), outsider = await person(f), saved = await addWish(f, owner), path = `/api/wishes/${saved.id}/image`;
  assert.equal((await f.wishCall(path, owner)).status, 404);
  for (const data of [new Uint8Array(), new TextEncoder().encode('<svg><script>alert(1)</script></svg>')]) assert.equal((await f.wishCall(path, { method: 'POST', ...owner, raw: data, headers: { 'Content-Type': 'image/png' } })).status, 415);
  assert.equal((await f.wishCall(path, { method: 'POST', ...owner, raw: new Uint8Array(2097153) })).status, 413);
  assert.equal((await f.wishCall(path, { method: 'POST', ...owner, raw: png, headers: { 'Content-Length': '2097153' } })).status, 413);
  let oldKey;
  for (const [data, contentType] of [[png, 'image/png'], [jpeg, 'image/jpeg'], [webp, 'image/webp']]) {
    const uploaded = await f.wishCall(path, { method: 'POST', ...owner, raw: data, headers: { 'Content-Type': 'text/html' } });
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
    assert.equal(uploaded.data.wish.imageUrl, path);
    const key = f.sqlite.prepare('SELECT image_key FROM training_wishes WHERE id=?').get(saved.id).image_key;
    assert.match(key, new RegExp(`^wishes/${owner.account.id}/${saved.id}/`));
    if (oldKey) assert.equal(await f.env.BUCKET.get(oldKey), null);
    oldKey = key;
    const image = await f.wishCall(path, owner);
    assert.equal(image.response.headers.get('Content-Type'), contentType);
    assert.equal(image.response.headers.get('Cache-Control'), 'no-store');
    assert.equal(image.response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.deepEqual(image.data, data);
    assert.equal((await f.wishCall(path, outsider)).status, 404);
    assert.equal((await f.wishCall(path)).status, 401);
  }
  const cleared = await f.wishCall(path, { method: 'DELETE', ...owner });
  assert.equal(cleared.data.wish.imageUrl, null);
  assert.equal(await f.env.BUCKET.get(oldKey), null);
  await f.wishCall(path, { method: 'POST', ...owner, raw: png });
  const finalKey = f.sqlite.prepare('SELECT image_key FROM training_wishes WHERE id=?').get(saved.id).image_key;
  assert.equal((await f.wishCall(`/api/wishes/${saved.id}`, { method: 'DELETE', ...owner })).status, 200);
  assert.equal(await f.env.BUCKET.get(finalKey), null);
  assert.equal((await f.wishCall(path, owner)).status, 404);
});

test('failed or racing image updates remove their pending object without losing a concurrent winner', async t => {
  const f = wishFixture(t), owner = await person(f), saved = await addWish(f, owner), path = `/api/wishes/${saved.id}/image`;
  const realBucket = f.env.BUCKET, uploaded = [];
  const env = { ...f.env, BUCKET: { ...realBucket, async put(key, data, metadata) {
    uploaded.push(key); await realBucket.put(key, data, metadata);
    if (uploaded.length === 1) {
      const winner = 'wishes/concurrent-winner';
      await realBucket.put(winner, jpeg, { httpMetadata: { contentType: 'image/jpeg' } });
      f.sqlite.prepare('UPDATE training_wishes SET image_key=? WHERE id=?').run(winner, saved.id);
    } else {
      f.sqlite.prepare('DELETE FROM training_wishes WHERE id=?').run(saved.id);
    }
  } } };
  const lostRace = await f.wishCall(path, { method: 'POST', ...owner, raw: png, env });
  assert.equal(lostRace.status, 409);
  assert.equal(await realBucket.get(uploaded[0]), null);
  assert.ok(await realBucket.get('wishes/concurrent-winner'));
  assert.deepEqual((await f.wishCall(path, owner)).data, jpeg);
  const deletedDuringUpload = await f.wishCall(path, { method: 'POST', ...owner, raw: png, env });
  assert.equal(deletedDuringUpload.status, 409);
  assert.equal(await realBucket.get(uploaded[1]), null);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM training_wishes').get().n, 0);
});

test('CORS and routing preserve fresh origin and private errors without intercepting other APIs', async t => {
  const f = wishFixture(t), owner = await person(f);
  assert.equal(await f.wishCall('/api/board', owner), null);
  assert.equal(await f.wishCall('/api/wishes-extra', owner), null);
  const denied = await f.wishCall('/api/wishes', { ...owner, origin: 'https://evil.example' });
  assert.equal(denied.status, 403);
  assert.equal(denied.response.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await f.wishCall('/api/wishes', { ...owner, origin: null, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const headers = { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-tennis-session' };
  const preflight = await f.wishCall('/api/wishes', { method: 'OPTIONS', headers });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.response.headers.get('Access-Control-Allow-Origin'), 'https://zjwzkongqc.github.io');
  assert.equal((await f.wishCall('/api/wishes', { method: 'OPTIONS', origin: 'https://evil.example', headers })).status, 403);
  assert.equal((await f.wishCall('/api/wishes', { method: 'OPTIONS', headers: { ...headers, 'Access-Control-Request-Headers': 'x-admin' } })).status, 403);
  assert.equal((await f.wishCall('/api/wishes', { method: 'PUT', ...owner })).status, 405);
  assert.equal((await f.wishCall('/api/wishes/not-an-id', owner)).status, 404);
  const errorEnv = { ...f.env, DB: { prepare() { throw new Error('server-only-password or private row value'); } } };
  const unavailable = await f.wishCall('/api/wishes', { ...owner, env: errorEnv });
  assert.equal(unavailable.status, 503);
  assert.equal(JSON.stringify(unavailable.data).includes('server-only-password'), false);
});
