import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
const nonce=()=>Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const start=(f,nickname='球友',startNonce=nonce(),options={})=>f.call('/api/auth/start',{method:'POST',body:{nickname,startNonce},...options});

test('nickname-only accounts have a genuine session and recovery login without email credentials',async t=>{
  const f=fixture(t),created=await start(f,'免邮箱球友');assert.equal(created.status,201);assert.match(created.data.recoveryCode,/^TC-(?:[A-F0-9]{8}-){4}[A-F0-9]{8}$/);
  const account=f.sqlite.prepare('SELECT * FROM accounts').get();assert.equal(account.display_name,'免邮箱球友');assert.notEqual(account.recovery_hash,created.data.recoveryCode);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM account_credentials').get().n,0);
  const remembered=await f.call('/api/auth/me',{accountToken:created.data.sessionToken});assert.equal(remembered.data.account.id,created.data.account.id);assert.equal(remembered.data.account.hasEmail,false);
  const logged=await f.login(created.data.recoveryCode);assert.equal(logged.status,200);assert.equal(logged.data.account.id,created.data.account.id);assert.notEqual(logged.data.sessionToken,created.data.sessionToken);
  const sameOrigin=await start(f,'同源球友',nonce(),{origin:'https://tennis-dazi-club-2026.divine-seal-5110.chatgpt.site'});assert.equal(sameOrigin.status,201);assert.equal(sameOrigin.data.sessionToken,undefined);assert.match(sameOrigin.response.headers.get('Set-Cookie'),/HttpOnly; SameSite=Lax/);
});
test('retrying a lost first reply keeps exactly one account and the original recovery code',async t=>{
  const f=fixture(t),startNonce=nonce(),first=await start(f,'原昵称',startNonce),retry=await start(f,'后来填写的昵称',startNonce);assert.equal(retry.status,201);assert.equal(retry.data.account.id,first.data.account.id);assert.equal(retry.data.account.displayName,'原昵称');assert.equal(retry.data.recoveryCode,first.data.recoveryCode);assert.notEqual(retry.data.sessionToken,first.data.sessionToken);
  const cookieRetry=await start(f,'原昵称',startNonce,{accountToken:first.data.sessionToken});assert.equal(cookieRetry.status,201);assert.equal(cookieRetry.data.account.id,first.data.account.id);assert.equal(cookieRetry.data.recoveryCode,first.data.recoveryCode);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM accounts').get().n,1);
});
test('a failed first session rolls back the new nickname account and leaves its nonce retryable',async t=>{
  const f=fixture(t),startNonce=nonce();f.failOnce(/INSERT INTO account_sessions/);const failed=await start(f,'球友',startNonce);assert.equal(failed.status,503);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM accounts').get().n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM account_sessions').get().n,0);
  const retry=await start(f,'球友',startNonce);assert.equal(retry.status,201);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM accounts').get().n,1);
});
test('invalid startup data and untrusted requests cannot create an account',async t=>{
  const f=fixture(t);for(const body of [{nickname:'球友'},{nickname:'球友',startNonce:'abc'},{nickname:'球友',startNonce:'A'.repeat(64)},{nickname:'   ',startNonce:nonce()},{nickname:'a'.repeat(21),startNonce:nonce()}])assert.equal((await f.call('/api/auth/start',{method:'POST',body})).status,400);
  assert.equal((await start(f,'球友',nonce(),{origin:'https://attacker.test'})).status,403);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM accounts').get().n,0);
});
test('old browser cards and another signed-in account cannot be overwritten by nickname startup',async t=>{
  const f=fixture(t),legacy=await f.createClub();assert.equal((await start(f,'新昵称',nonce(),{token:legacy.token})).status,409);assert.equal(f.sqlite.prepare('SELECT account_id FROM members WHERE id=?').get(legacy.memberId).account_id,null);
  assert.equal((await f.call('/api/board',{invite:legacy.invite,token:legacy.token})).data.me,legacy.memberId);
  const a=await start(f,'A');assert.equal((await start(f,'B',nonce(),{accountToken:a.data.sessionToken})).status,409);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM accounts').get().n,1);
  const saved=await f.enableRecovery(legacy);assert.equal((await f.login(saved.recoveryCode)).data.account.id,saved.account.id);
});
test('rotating recovery invalidates old startup proof without adding accounts or sessions',async t=>{
  const f=fixture(t),startNonce=nonce(),a=await start(f,'球友',startNonce);assert.equal((await f.call('/api/auth/recovery',{method:'POST',accountToken:a.data.sessionToken,body:{}})).status,200);
  const count=f.sqlite.prepare('SELECT COUNT(*) n FROM account_sessions').get().n;const retry=await start(f,'球友',startNonce);assert.equal(retry.status,401);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM accounts').get().n,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM account_sessions').get().n,count);
});
test('recovery rotation during nonce retry cannot mint a session with obsolete proof',async t=>{
  const f=fixture(t),startNonce=nonce(),a=await start(f,'球友',startNonce),before=f.sqlite.prepare('SELECT COUNT(*) n FROM account_sessions').get().n;
  f.beforeOnce(/INSERT INTO account_sessions/,sqlite=>sqlite.prepare('UPDATE accounts SET recovery_hash=? WHERE id=?').run('f'.repeat(64),a.data.account.id));assert.equal((await start(f,'球友',startNonce)).status,401);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM account_sessions').get().n,before);
});
test('two same-name nickname accounts share only their group and retain owner-only edits across devices',async t=>{
  const f=fixture(t),a=(await start(f,'同名')).data,b=(await start(f,'同名')).data;assert.notEqual(a.account.id,b.account.id);const A={accountToken:a.sessionToken},B={accountToken:b.sessionToken};
  const c=await f.call('/api/clubs',{method:'POST',...A,body:{name:'六人网球',nickname:'同名A'}});assert.equal(c.status,201);const invite=c.data.invite;assert.equal((await f.call('/api/profile',{method:'POST',invite,...B,body:{nickname:'同名B',bio:''}})).status,201);
  const board=(await f.call('/api/board',{invite,...A})).data,memberA=board.me,clubId=board.club.id;assert.equal(board.members.length,2);
  const path='/api/ratings?club='+clubId,skills={forehand:0,backhand:null,serve:7,return_skill:null,net:4,footwork:6};assert.equal((await f.call(path,{method:'POST',...A,body:{month:'2026-01',skills}})).status,200);assert.equal((await f.call(path,{method:'POST',...B,body:{month:'2026-01',skills,memberId:memberA}})).status,403);
  const recovered=await f.login(a.recoveryCode),otherDevice=await f.call('/api/board?club='+clubId,{accountToken:recovered.data.sessionToken});assert.equal(otherDevice.data.me,memberA);assert.equal(otherDevice.data.members.find(m=>m.id===memberA).rating.forehand,0);assert.equal(otherDevice.data.members.find(m=>m.id===memberA).rating.backhand,null);
});
