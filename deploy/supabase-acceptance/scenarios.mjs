// Synthetic acceptance only. No original account, snapshot, or migration receipt.
export async function runScenarios({ worker, DB, BUCKET, connection, origin, rawBucket }) {
  const checks = []; let stage = 'initialization'; const mediaKeys = new Set();
  const trackedBucket = { ...BUCKET, async put(key, ...args) { mediaKeys.add(key); return BUCKET.put(key, ...args); } };
  const env = { DB, BUCKET: trackedBucket };
  function check(name, condition) { stage = name; if (!condition) throw new Error(name); checks.push(name); }
  async function call(name, path, { method = 'GET', user, invite, data, bytes, headers = {}, status = 200 } = {}) {
    stage = name;
    const h = new Headers({ Origin: 'https://zjwzkongqc.github.io', 'CF-Connecting-IP': 'isolated-acceptance', ...headers });
    if (user) h.set('X-Tennis-Session', user.sessionToken);
    if (invite) h.set('Authorization', 'Bearer ' + invite);
    if (data !== undefined) h.set('Content-Type', 'application/json');
    if (bytes) h.set('Content-Type', 'image/png');
    const response = await worker.fetch(new Request(origin + path, { method, headers: h, body: bytes || (data !== undefined ? JSON.stringify(data) : undefined) }), env);
    check(name, response.status === status);
    if (response.status === 204) return null;
    const type = response.headers.get('Content-Type') || '';
    if (type.includes('application/json')) return await response.json();
    if (type.includes('application/x-ndjson')) return (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    return new Uint8Array(await response.arrayBuffer());
  }
  const nonce = () => [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join('');
  let failure = null;
  try {
    const boundary = await connection.unsafe("SELECT current_user AS role, current_schema() AS schema, has_table_privilege(current_user,'public.accounts','SELECT') AS production_read, has_table_privilege(current_user,'public.records','INSERT') AS production_write");
    check('test-role-cannot-read-or-write-production', boundary[0].role === 'tennis_acceptance_runner' && boundary[0].schema === 'tennis_acceptance' && !boundary[0].production_read && !boundary[0].production_write);
    await call('pages-cors-preflight', '/api/records', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-tennis-session' }, status: 204 });
    await call('foreign-origin-preflight-denied', '/api/records', { method: 'OPTIONS', headers: { Origin: 'https://invalid.example', 'Access-Control-Request-Method': 'POST' }, status: 403 });
    const anonymous = await call('anonymous-identity', '/api/auth/me');
    check('anonymous-has-no-account', anonymous.account === null && anonymous.clubs.length === 0);
    const users = []; const nonces = [];
    for (let i = 0; i < 6; i++) {
      nonces.push(nonce());
      users.push(await call('register-member-' + (i + 1), '/api/auth/start', { method: 'POST', data: { nickname: '验收测试' + (i + 1), startNonce: nonces[i] }, status: 201 }));
    }
    check('six-distinct-identities', new Set(users.map(u => u.account.id)).size === 6);
    const A = users[0], B = users[1];
    const retry = await call('retry-lost-registration-reply', '/api/auth/start', { method: 'POST', data: { nickname: '验收测试1', startNonce: nonces[0] }, status: 201 });
    check('registration-retry-does-not-duplicate-account', retry.account.id === A.account.id && retry.recoveryCode === A.recoveryCode);
    const created = await call('owner-creates-synthetic-group', '/api/clubs', { method: 'POST', user: A, data: { name: '隔离验收测试组', nickname: '验收测试1', slogan: '不是正式球友资料' }, status: 201 });
    const ownerInfo = await call('owner-group-persisted', '/api/auth/me', { user: A });
    const club = ownerInfo.clubs[0].id, group = '?club=' + encodeURIComponent(club);
    for (let i = 1; i < 6; i++) await call('join-member-' + (i + 1), '/api/profile', { method: 'POST', user: users[i], invite: created.invite, data: { nickname: '验收测试' + (i + 1), bio: 'synthetic acceptance' }, status: 201 });
    let board = await call('six-member-board', '/api/board' + group, { user: A });
    check('six-members-visible-to-group', board.members.length === 6);
    const memberA = board.me;
    const boardB = await call('second-member-own-identity', '/api/board' + group, { user: B });
    const memberB = boardB.me;
    check('members-do-not-share-identity', memberA !== memberB);
    await call('anonymous-group-access-denied', '/api/board' + group, { status: 401 });
    const outsider = await call('register-outsider', '/api/auth/start', { method: 'POST', data: { nickname: '验收组外测试', startNonce: nonce() }, status: 201 });
    await call('nonmember-group-access-denied', '/api/board' + group, { user: outsider, status: 403 });
    await call('invitation-is-not-membership', '/api/board', { user: outsider, invite: created.invite, status: 401 });
    await call('nickname-is-not-recovery-credential', '/api/auth/login', { method: 'POST', data: { recoveryCode: '验收测试1' }, status: 401 });
    const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), month = day.slice(0, 7);
    const skills = { forehand: 0, backhand: null, serve: 5, return_skill: 5, net: 5, footwork: 5 };
    const input = { id: crypto.randomUUID(), playDate: day, minutes: 45, partners: 'synthetic', venue: '验收场地', mood: '认真练球', note: 'synthetic-persistence-test', skills, training: { projects: ['backhand'], content: '单反练习', effect: 'practice', effectNote: '测试', nextPlan: '测试复习' } };
    await call('save-training-record', '/api/records' + group, { method: 'POST', user: A, data: input, status: 201 });
    await call('record-save-retry-is-idempotent', '/api/records' + group, { method: 'POST', user: A, data: input, status: 201 });
    await call('save-current-month-rating', '/api/ratings' + group, { method: 'POST', user: A, data: { month, skills } });
    await call('save-historical-month-rating', '/api/ratings' + group, { method: 'POST', user: A, data: { month: '2026-09', skills: { ...skills, serve: 4 } } });
    const history = await call('read-monthly-history', '/api/ratings' + group, { user: A });
    check('monthly-history-zero-and-unrated-preserved', history.ratings.length === 2 && history.ratings.find(x => x.month === month).forehand === 0 && history.ratings.find(x => x.month === month).backhand === null);
    await call('rating-outside-range-rejected', '/api/ratings' + group, { method: 'POST', user: A, data: { month, skills: { ...skills, serve: 11 } }, status: 400 });
    await call('member-cannot-edit-other-record', '/api/records/' + input.id + group, { method: 'PATCH', user: B, data: { ...input, note: 'tampered' }, status: 403 });
    await call('member-cannot-delete-other-record', '/api/records/' + input.id + group, { method: 'DELETE', user: B, status: 403 });
    await call('member-cannot-edit-other-rating', '/api/ratings' + group, { method: 'POST', user: B, data: { month, memberId: memberA, skills }, status: 403 });
    await call('member-cannot-edit-other-profile', '/api/members/' + memberA + '/profile' + group, { method: 'POST', user: B, data: { nickname: 'tampered', bio: '' }, status: 403 });
    await call('other-member-cannot-reuse-record-id', '/api/records' + group, { method: 'POST', user: B, data: input, status: 409 });
    const otherRecord = { ...input, id: crypto.randomUUID(), note: 'member-two-record' };
    await call('second-member-can-save-own-record', '/api/records' + group, { method: 'POST', user: B, data: otherRecord, status: 201 });
    board = await call('read-saved-records-after-writes', '/api/board' + group, { user: A });
    const saved = board.records.find(r => r.id === input.id);
    check('record-and-training-persisted-without-tampering', board.records.length === 2 && saved.note === input.note && saved.minutes === 45 && saved.training_content === '单反练习' && saved.forehand === 0 && saved.backhand === null);
    await call('owner-can-edit-own-record', '/api/records/' + input.id + group, { method: 'PATCH', user: A, data: { ...input, note: 'updated-by-owner' } });
    const restored = await call('recover-on-new-device-session', '/api/auth/login', { method: 'POST', data: { recoveryCode: A.recoveryCode } });
    check('recovery-retains-original-identity', restored.account.id === A.account.id && restored.sessionToken !== A.sessionToken);
    const recoveredBoard = await call('recovered-session-reads-saved-record', '/api/board' + group, { user: restored });
    check('recovered-session-retains-record-and-owner-role', recoveredBoard.me === memberA && recoveredBoard.club.ownerId === memberA && recoveredBoard.records.find(r => r.id === input.id).note === 'updated-by-owner');
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZuoAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const photo = await call('save-private-training-photo', '/api/records/' + input.id + '/photos' + group, { method: 'POST', user: A, bytes: png, status: 201 });
    const image = await call('group-member-can-read-private-photo', '/api/photos/' + photo.id + group, { user: B });
    check('private-photo-bytes-preserved', image.length === png.length && image.every((v, i) => v === png[i]));
    await call('anonymous-photo-access-denied', '/api/photos/' + photo.id + group, { status: 401 });
    await call('nonmember-photo-access-denied', '/api/photos/' + photo.id + group, { user: outsider, status: 403 });
    await call('member-cannot-delete-other-photo', '/api/photos/' + photo.id + group, { method: 'DELETE', user: B, status: 403 });
    const objectKey = [...mediaKeys][0];
    const direct = await fetch(origin + '/storage/v1/object/public/' + rawBucket + '/' + objectKey, { redirect: 'error' });
    check('storage-bucket-not-public', !direct.ok); await direct.body?.cancel();
    const backup = await call('owner-downloads-group-backup', '/api/export' + group, { user: A });
    check('group-backup-has-records-and-photo-bytes-not-credentials', backup[0].records.length === 2 && backup.some(x => x.kind === 'photo' && x.base64) && !Object.hasOwn(backup[0], 'accounts') && !Object.hasOwn(backup[0], 'account_credentials'));
    await call('member-cannot-export-admin-backup', '/api/export' + group, { user: B, status: 403 });
    await call('remove-member', '/api/members/' + memberB + group, { method: 'DELETE', user: A });
    await call('removed-member-board-denied', '/api/board' + group, { user: B, status: 403 });
    await call('removed-member-photo-denied', '/api/photos/' + photo.id + group, { user: B, status: 403 });
    await call('restore-member', '/api/members/' + memberB + group, { method: 'PATCH', user: A });
    await call('restored-member-board-allowed', '/api/board' + group, { user: B });
    await call('logout-recovered-session', '/api/auth/logout', { method: 'POST', user: restored, data: {} });
    const afterLogout = await call('read-logged-out-session', '/api/auth/me', { user: restored });
    check('logout-revokes-session', afterLogout.account === null);
  } catch { failure = stage; }
  // The role has no access to production. These tables contain only synthetic
  // fixtures; this endpoint has no user-supplied commands or application routes.
  let cleaned = true;
  for (const key of mediaKeys) { try { await BUCKET.delete(key); } catch { cleaned = false; } }
  try {
    await connection.begin('isolation level serializable', async tx => {
      for (const table of ['cheers','record_photos','monthly_ratings','checkins','audit_events','culture','records','club_invites','auth_registrations','account_sessions','account_credentials','members','clubs','auth_failures','accounts']) await tx.unsafe('DELETE FROM ' + table);
    });
  } catch { cleaned = false; }
  return { passed: !failure && cleaned, checks, failedCheck: failure, cleanup: cleaned, fixtureMembers: 6, productionMigrated: false, browserHardwareTested: false, mainlandAccessTested: false, scope: 'shared application handler + live isolated PostgreSQL and private Storage; not production cutover' };
}
