import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
const password='Tennis-test-password-2026';
const skills={forehand:0,backhand:null,serve:7,return_skill:null,net:4,footwork:6};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7ioAAAAASUVORK5CYII=','base64');
async function setup(t){
  const f=fixture(t),emailA='a-'+crypto.randomUUID()+'@example.test',emailB='b-'+crypto.randomUUID()+'@example.test';
  const signup=async(email,nickname)=>{const r=await f.call('/api/auth/signup',{method:'POST',body:{email,password,nickname}});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;};
  const a=await signup(emailA,'A'),b=await signup(emailB,'B'),A={accountToken:a.sessionToken},B={accountToken:b.sessionToken};
  const created=await f.call('/api/clubs',{method:'POST',...A,body:{name:'六人网球验收',nickname:'球友A',slogan:''}});assert.equal(created.status,201);
  const invite=created.data.invite,board=await f.call('/api/board',{invite,...A}),clubId=board.data.club.id,memberA=board.data.me;
  const joined=await f.call('/api/profile',{method:'POST',invite,...B,body:{nickname:'球友B',bio:''}});assert.equal(joined.status,201);
  return {f,a,b,A,B,emailA,emailB,clubId,memberA,memberB:joined.data.id,invite,path:p=>p+(p.includes('?')?'&':'?')+'club='+clubId};
}
test('email accounts persist across sessions and password hashes are never stored as plaintext',async t=>{
  const {f,a,A,emailA,memberA,path}=await setup(t),row=f.sqlite.prepare('SELECT * FROM account_credentials WHERE account_id=?').get(a.account.id);
  assert.notEqual(row.password_hash,password);assert.equal(row.password_hash.length,64);
  const login=await f.call('/api/auth/login',{method:'POST',body:{email:emailA.toUpperCase(),password}});assert.equal(login.status,200);assert.notEqual(login.data.sessionToken,A.accountToken);
  assert.equal((await f.call(path('/api/board'),{accountToken:login.data.sessionToken})).data.me,memberA);
  assert.equal((await f.call('/api/auth/login',{method:'POST',body:{email:emailA,password:'incorrect-password'}})).status,401);
  assert.equal((await f.call('/api/auth/login',{method:'POST',body:{email:'unknown@example.test',password:'incorrect-password'}})).status,401);
  assert.equal((await f.call('/api/clubs',{method:'POST',body:{name:'anonymous',nickname:'guest'}})).status,401);
});
test('changing a password during login prevents an old password from creating a session',async t=>{
  const {f,a,emailA}=await setup(t),before=f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n;
  f.beforeOnce(/INSERT INTO account_sessions/,(sqlite)=>sqlite.prepare('UPDATE account_credentials SET password_hash=? WHERE account_id=?').run('0'.repeat(64),a.account.id));
  const result=await f.call('/api/auth/login',{method:'POST',body:{email:emailA,password}});assert.equal(result.status,401);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n,before);
});
test('legacy recovery can bind email without changing member, avatar, record or owner identity',async t=>{
  const f=fixture(t),legacy=await f.createClub(),saved=await f.enableRecovery(legacy),A={accountToken:saved.accountToken};
  const rid=crypto.randomUUID();assert.equal((await f.call('/api/records',{method:'POST',invite:legacy.invite,...A,body:{id:rid,playDate:'2026-01-20',minutes:45,mood:'认真练球'}})).status,201);
  const email='legacy@example.test';assert.equal((await f.call('/api/auth/credentials',{method:'POST',...A,body:{email,password}})).status,200);
  const login=await f.call('/api/auth/login',{method:'POST',body:{email,password}});assert.equal(login.data.account.id,saved.account.id);
  const board=await f.call('/api/board?club='+legacy.clubId,{accountToken:login.data.sessionToken});assert.equal(board.data.me,legacy.memberId);assert.equal(board.data.club.ownerId,legacy.memberId);assert.equal(board.data.records[0].id,rid);
});
test('invitation previews disclose no member content and anonymous invite holders cannot read private APIs',async t=>{
  const {f,invite,A,B,memberA,path}=await setup(t),preview=await f.call('/api/invitation',{invite});assert.equal(preview.status,200);assert.deepEqual(Object.keys(preview.data).sort(),['club','joined','legacy']);
  for(const p of ['/api/board','/api/growth','/api/avatar/'+memberA])assert.equal((await f.call(p,{invite})).status,401);
  assert.equal((await f.call('/api/profile',{method:'POST',invite,body:{nickname:'anon'}})).status,401);
  assert.equal((await f.call(path('/api/invite'),{method:'POST',...B,body:{}})).status,403);
  const issued=await f.call(path('/api/invite'),{method:'POST',...A,body:{}});assert.equal(issued.status,200);
  const invHash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(issued.data.invite))).toString('hex');
  assert.equal((await f.call(path('/api/invites/'+invHash),{method:'DELETE',...A})).status,200);
  assert.equal((await f.call('/api/invitation',{invite:issued.data.invite})).status,404);
  assert.equal((await f.call(path('/api/invites/original'),{method:'DELETE',...A})).status,200);assert.equal((await f.call('/api/invitation',{invite})).status,404);
  assert.equal((await f.call(path('/api/board'),B)).status,200);
});
test('month snapshots preserve zeros and nulls, stay independent and enforce ownership',async t=>{
  const {f,A,B,memberA,path}=await setup(t);
  for(const month of ['2026-08','2026-09'])assert.equal((await f.call(path('/api/ratings'),{method:'POST',...A,body:{month,skills}})).status,200);
  const next={...skills,forehand:2};assert.equal((await f.call(path('/api/ratings'),{method:'POST',...A,body:{month:'2026-09',skills:next}})).status,200);
  assert.equal((await f.call(path('/api/ratings'),{method:'POST',...B,body:{month:'2026-09',skills:next,memberId:memberA}})).status,403);
  const list=(await f.call(path('/api/ratings'),A)).data.ratings;assert.equal(list.length,2);assert.equal(list[0].forehand,2);assert.equal(list[1].forehand,0);assert.equal(list[1].backhand,null);
  for(const value of [-1,11,'5'])assert.equal((await f.call(path('/api/ratings'),{method:'POST',...A,body:{month:'2026-09',skills:{...skills,forehand:value}}})).status,400);
});
test('private photos enforce record ownership and revoking a public card revokes its avatar',async t=>{
  const {f,A,B,invite,memberA,path}=await setup(t),rid=crypto.randomUUID();
  assert.equal((await f.call(path('/api/records'),{method:'POST',...A,body:{id:rid,playDate:'2026-01-20',minutes:45,mood:'认真练球',skills}})).status,201);
  assert.equal((await f.call(path(`/api/records/${rid}/photos`),{method:'POST',...B,raw:png})).status,403);
  const uploaded=await f.call(path(`/api/records/${rid}/photos`),{method:'POST',...A,raw:png});assert.equal(uploaded.status,201,JSON.stringify(uploaded.data));
  const photoId=uploaded.data.id;assert.equal((await f.call(path('/api/photos/'+photoId),B)).status,200);assert.equal((await f.call('/api/photos/'+photoId,{invite})).status,401);assert.equal((await f.call(path('/api/photos/'+photoId),{method:'DELETE',...B})).status,403);
  assert.equal((await f.call(path('/api/avatar'),{method:'POST',...A,raw:png})).status,200);
  const shared=await f.call(path('/api/share'),{method:'POST',...A,body:{enabled:true}}),token=shared.data.token,card=await f.call('/api/public/card/'+token);assert.equal(card.status,200);assert.deepEqual(Object.keys(card.data).sort(),['bio','hasAvatar','nickname','rating']);
  assert.equal((await f.call('/api/public/avatar/'+token)).status,200);
  assert.equal((await f.call(path('/api/share'),{method:'POST',...B,body:{enabled:false,memberId:memberA}})).status,200);assert.equal((await f.call('/api/public/card/'+token)).status,200);
  await f.call(path('/api/share'),{method:'POST',...A,body:{enabled:false}});assert.equal((await f.call('/api/public/card/'+token)).status,404);assert.equal((await f.call('/api/public/avatar/'+token)).status,404);
  assert.equal((await f.call(path('/api/records/'+rid),{method:'DELETE',...B})).status,403);assert.equal((await f.call(path('/api/records/'+rid),{method:'DELETE',...A})).status,200);assert.equal((await f.call(path('/api/photos/'+photoId),B)).status,404);
});
test('admin removal blocks existing sessions, preserves history and records admin edits in portable backups',async t=>{
  const {f,A,B,memberB,invite,path}=await setup(t),rid=crypto.randomUUID();
  await f.call(path('/api/records'),{method:'POST',...B,body:{id:rid,playDate:'2026-01-20',minutes:40,mood:'认真练球'}});
  await f.call(path(`/api/records/${rid}/photos`),{method:'POST',...B,raw:png});
  assert.equal((await f.call(path('/api/members/'+memberB+'/profile'),{method:'POST',...A,body:{nickname:'管理员已修正',bio:'审计测试'}})).status,200);
  assert.equal((await f.call(path('/api/export'),B)).status,403);
  assert.equal((await f.call(path('/api/members/'+memberB),{method:'DELETE',...A})).status,200);
  for(const endpoint of ['/api/board','/api/growth','/api/avatar/'+memberB])assert.equal((await f.call(path(endpoint),B)).status,403);
  assert.equal((await f.call('/api/profile',{method:'POST',invite,...B,body:{nickname:'不能自行重进'}})).status,403);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM records WHERE id=?').get(rid).n,1);
  const backup=await f.call(path('/api/export'),A);assert.equal(backup.status,200);const lines=backup.data.trim().split('\n').map(JSON.parse);assert.equal(lines[0].records.length,1);assert.ok(lines[0].audit.some(e=>e.action==='edit-profile'));assert.ok(lines.some(e=>e.kind==='photo'&&e.base64));
  for(const forbidden of ['password_hash','password_salt','recovery_hash','session_hash','@example.test'])assert.equal(backup.data.includes(forbidden),false);
  assert.equal((await f.call(path('/api/members/'+memberB),{method:'PATCH',...A,body:{}})).status,200);assert.equal((await f.call(path('/api/board'),B)).status,200);
});
