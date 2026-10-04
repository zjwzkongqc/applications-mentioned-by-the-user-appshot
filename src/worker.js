/*__ASSETS__*/
const encoder = new TextEncoder();
const MAX_BODY = 20000;
const PAGES_ORIGIN = 'https://zjwzkongqc.github.io';
const pagesRequest = r => r.headers.get('Origin') === PAGES_ORIGIN;
const ACCOUNT_SESSION_AGE = 180*86400000;
const AUTH_WINDOW = 15*60000;
const REGISTRATION_RECEIPT_AGE = 60*60000;
const MOODS = ['手感在线','快乐拉球','认真练球','虽败犹荣','饭后消食'];
const EMOJIS = ['👏','🔥','🎾'];
const SKILLS = ['forehand','backhand','serve','return_skill','net','footwork'];
const PROJECTS = ['forehand','backhand','serve','return_skill','net','footwork','fitness','match','other'];
const EFFECTS = ['improved','some','practice','exploring'];
const chinaDay = () => new Date(Date.now()+8*60*60*1000).toISOString().slice(0,10);
const shiftDay = (day,offset) => new Date(new Date(`${day}T00:00:00Z`).getTime()+offset*86400000).toISOString().slice(0,10);
function trainingInput(b,existing){
  if(!Object.prototype.hasOwnProperty.call(b,'training'))return [existing?.training_projects||'[]',existing?.training_content||'',existing?.training_effect||'',existing?.effect_note||'',existing?.next_plan||''];
  if(b.training===null)return ['[]','','','',''];
  const t=b.training;
  if(!t||typeof t!=='object'||Array.isArray(t)||!Array.isArray(t.projects)||!t.projects.length||t.projects.length>PROJECTS.length||t.projects.some(k=>!PROJECTS.includes(k))||new Set(t.projects).size!==t.projects.length)problem('请至少选择一个训练项目。');
  const effect=t.effect||'';if(effect&&!EFFECTS.includes(effect))problem('请选择页面中的训练效果。');
  return [JSON.stringify(t.projects),str(t.content||'',1000),effect,str(t.effectNote||'',500),str(t.nextPlan||'',500)];
}
function checkinStatement(clubId,memberId){return ['INSERT INTO checkins(id,club_id,member_id,checkin_date,created_at) VALUES(?,?,?,?,?) ON CONFLICT(member_id,checkin_date) DO NOTHING',crypto.randomUUID(),clubId,memberId,chinaDay(),new Date().toISOString()];}
function skillInput(b,existing){
  if(!Object.prototype.hasOwnProperty.call(b,'skills'))return SKILLS.map(k=>existing?.[k]??null);
  if(b.skills===null)return SKILLS.map(()=>null);
  if(!b.skills||typeof b.skills!=='object'||Array.isArray(b.skills)||Object.keys(b.skills).length!==6||SKILLS.some(k=>!Number.isInteger(b.skills[k])||b.skills[k]<1||b.skills[k]>10))problem('六维自评请完整填写，每项选择 1–10 分。');
  return SKILLS.map(k=>b.skills[k]);
}
function problem(message,status=400){throw Object.assign(new Error(message),{status});}
function json(data,status=200,extra={}){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra}});}
async function digest(s){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(s)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
function secret(bytes=32){return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');}
function cookie(r){return r.headers.get('Cookie')?.match(/(?:^|;\s*)tc_session=([a-f0-9]{64})(?:;|$)/)?.[1] || null;}
function registrationLegacyCookie(r){return r.headers.get('Cookie')?.match(/(?:^|;\s*)tc_registration_legacy=([a-f0-9]{64})(?:;|$)/)?.[1] || null;}
function session(r){const token=r.headers.get('X-Tennis-Session');return token!==null?(/^[a-f0-9]{64}$/.test(token)?token:null):cookie(r);}
function sessionResult(data,token,r){return pagesRequest(r)?{...data,sessionToken:token}:data;}
function cookieHeader(token,url,age=31536000){return {'Set-Cookie':`tc_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${url.protocol==='https:'?'; Secure':''}`};}
function registrationCookieHeader(token,url,age=REGISTRATION_RECEIPT_AGE/1000){return `tc_registration_legacy=${token}; Path=/api/auth/register; HttpOnly; SameSite=Lax; Max-Age=${age}${url.protocol==='https:'?'; Secure':''}`;}
async function body(r){if(Number(r.headers.get('Content-Length'))>MAX_BODY)problem('填写的内容太长了。',413);if(!r.headers.get('Content-Type')?.includes('application/json'))problem('请使用页面中的表单提交。',415);let raw=await r.text();if(raw.length>MAX_BODY)problem('填写的内容太长了。',413);try{return JSON.parse(raw);}catch{problem('内容格式不正确，请重试。');}}
function str(v,max,required=false){if(typeof v!=='string')problem('请填写有效的文字。');v=v.trim();if(v.length>max || (required&&!v))problem(required?`请填写内容，最多 ${max} 个字。`:`内容最多 ${max} 个字。`);return v;}
function id(v){if(typeof v!=='string'||! /^[a-f0-9-]{36}$/.test(v))problem('记录编号无效。');return v;}
function recordInput(b){const date=str(b.playDate,10,true),parsed=new Date(`${date}T00:00:00Z`);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==date)problem('请选择有效的打球日期。');const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);if(date>tomorrow)problem('还没发生的场次，等打完再记。');const minutes=Number(b.minutes);if(!Number.isInteger(minutes)||minutes<1||minutes>1440)problem('时长请填 1–1440 分钟。');if(!MOODS.includes(b.mood))problem('请选择今天的状态。');return {date,minutes,partners:str(b.partners||'',120),venue:str(b.venue||'',60),mood:b.mood,note:str(b.note||'',500)};}
function db(env){if(!env.DB)problem('小本本暂时连不上，请稍后再试。',503);return {one:(sql,...args)=>env.DB.prepare(sql).bind(...args).first(),all:async(sql,...args)=>(await env.DB.prepare(sql).bind(...args).all()).results,run:(sql,...args)=>env.DB.prepare(sql).bind(...args).run(),batch:(statements)=>env.DB.batch(statements.map(([sql,...args])=>env.DB.prepare(sql).bind(...args)))};}
function accountView(account){return account?{id:account.id,displayName:account.display_name}:null;}
function normalizeRecoveryCode(value){
  if(typeof value!=='string'||value.length>200)return null;
  const canonical=value.toLowerCase().replace(/[\s-]/g,'').replace(/^tc/,'');
  return /^[a-f0-9]{40}$/.test(canonical)?canonical:null;
}
async function recoveryFromCanonical(canonical){return {code:'TC-'+canonical.toUpperCase().match(/.{8}/g).join('-'),hash:await digest(canonical)};}
async function newRecoveryCode(){return recoveryFromCanonical(secret(20));}
async function registrationRecoveryCode(token,nonce,accountId){return recoveryFromCanonical((await digest(`recovery-v1:${token}:${nonce}:${accountId}`)).slice(0,40));}
async function identity(r,q){
  const token=session(r),hash=token?await digest(token):null;
  const account=hash?await q.one('SELECT a.id,a.display_name FROM account_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.session_hash=? AND s.expires_at>?',hash,Date.now()):null;
  return {token,hash,account};
}
async function authAttempt(r,q){
  const ip=r.headers.get('CF-Connecting-IP')||'unknown';
  const key='ip:'+await digest(ip),now=Date.now();
  // Reserve the address budget before lookup. Success refunds only its own
  // reservation and never clears previous failures for the shared address.
  await q.run('INSERT INTO auth_failures(key,window_start,failures) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET window_start=CASE WHEN auth_failures.window_start<=? THEN excluded.window_start ELSE auth_failures.window_start END,failures=CASE WHEN auth_failures.window_start<=? THEN 1 ELSE auth_failures.failures+1 END',key,now,now-AUTH_WINDOW,now-AUTH_WINDOW);
  const row=await q.one('SELECT failures FROM auth_failures WHERE key=?',key);if(Number(row.failures)>30)problem('尝试次数较多，请 15 分钟后再试。',429);
  await q.run('DELETE FROM auth_failures WHERE window_start<=?',now-AUTH_WINDOW);
  return key;
}
async function clearAuthAttempts(q,key){await q.run('UPDATE auth_failures SET failures=MAX(failures-1,0) WHERE key=?',key);}
async function newAccountSession(account){
  const token=secret(),now=Date.now();
  return {token,hash:await digest(token),accountId:account.id,expiresAt:now+ACCOUNT_SESSION_AGE,createdAt:new Date(now).toISOString()};
}
function accountSessionResponse(r,url,account,token,status=200,extra={},legacyBackupToken=null){
  const response=json(sessionResult({...extra,account:accountView(account)},token,r),status,cookieHeader(token,url,ACCOUNT_SESSION_AGE/1000));
  if(legacyBackupToken&&!pagesRequest(r))response.headers.append('Set-Cookie',registrationCookieHeader(legacyBackupToken,url));
  return response;
}
async function accountResponse(r,q,url,account,status=200,extra={},expectedRecoveryHash=null){
  const first=await newAccountSession(account);
  if(expectedRecoveryHash){
    const inserted=await q.run('INSERT INTO account_sessions(session_hash,account_id,expires_at,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM accounts WHERE id=? AND recovery_hash=?)',first.hash,first.accountId,first.expiresAt,first.createdAt,account.id,expectedRecoveryHash);
    if(!inserted.meta.changes)problem('私密登录码不正确，请检查后重试。',401);
  }else await q.run('INSERT INTO account_sessions(session_hash,account_id,expires_at,created_at) VALUES(?,?,?,?)',first.hash,first.accountId,first.expiresAt,first.createdAt);
  return accountSessionResponse(r,url,account,first.token,status,extra);
}
async function context(r,q,auth){
  auth=auth||await identity(r,q);
  const invite=r.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1],clubId=new URL(r.url).searchParams.get('club');
  let club,me;
  if(invite){
    const hash=await digest(invite);
    club=await q.one('SELECT * FROM clubs WHERE invite_hash=?',hash)||await q.one('SELECT c.* FROM club_invites i JOIN clubs c ON c.id=i.club_id WHERE i.invite_hash=?',hash);
    if(!club)problem('邀请链接无效，请向群友要一个新链接。',404);
  }else if(clubId){
    id(clubId);if(!auth.account)problem('请先登录，再进入自己的群小本本。',401);
    me=await q.one('SELECT * FROM members WHERE club_id=? AND account_id=?',clubId,auth.account.id);
    if(!me)problem('这个账号还未加入这本小本本，请通过群邀请链接进入。',403);
    club=await q.one('SELECT * FROM clubs WHERE id=?',clubId);
  }else problem('请从群里的邀请链接进入。',401);
  if(!me&&auth.account)me=await q.one('SELECT * FROM members WHERE club_id=? AND account_id=?',club.id,auth.account.id);
  if(!me&&!auth.account&&auth.hash)me=await q.one('SELECT * FROM members WHERE club_id=? AND session_hash=? AND account_id IS NULL',club.id,auth.hash);
  return {club,me,account:auth.account};
}
async function registerContext(r,q,auth){
  const clubId=new URL(r.url).searchParams.get('club');
  if(!r.headers.has('Authorization')&&clubId&&!auth.account){
    id(clubId);const me=auth.hash?await q.one('SELECT * FROM members WHERE club_id=? AND session_hash=? AND account_id IS NULL',clubId,auth.hash):null;
    if(!me)problem('请在原来建立名片的浏览器里设置登录。',401);
    return {me,club:await q.one('SELECT * FROM clubs WHERE id=?',clubId)};
  }
  return context(r,q,auth);
}
function memberOnly(c){if(!c.me)problem('先取个昵称，加入球友名片吧。',401);return c.me;}
const handler = {
  async fetch(r,env){const url=new URL(r.url);try{
    if(r.method==='GET' && !url.pathname.startsWith('/api/')){
      const security={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com"};
      if(url.pathname==='/app.js')return new Response(JS,{headers:{...security,'Content-Type':'text/javascript; charset=utf-8'}});
      if(url.pathname==='/hexagon.js')return new Response(HEX_JS,{headers:{...security,'Content-Type':'text/javascript; charset=utf-8'}});
      if(url.pathname==='/growth.js')return new Response(GROWTH_JS,{headers:{...security,'Content-Type':'text/javascript; charset=utf-8'}});
      if(url.pathname==='/style.css')return new Response(CSS,{headers:{...security,'Content-Type':'text/css; charset=utf-8'}});
      if(url.pathname==='/favicon.svg')return new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="12" fill="#143d2e"/><circle cx="20" cy="20" r="12" fill="#d5f566"/><path d="M12 10c10 5 10 15 0 20M28 10c-10 5-10 15 0 20" fill="none" stroke="#143d2e" stroke-width="2"/></svg>',{headers:{'Content-Type':'image/svg+xml'}});
      if(url.pathname!=='/')return new Response('页面不存在',{status:404});
      return new Response(HTML,{headers:{...security,'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'}});
    }
    if(!url.pathname.startsWith('/api/'))return json({error:'页面不存在'},404);
    if(r.method!=='GET'){
      const origin=r.headers.get('Origin');if(origin&&origin!==url.origin&&!pagesRequest(r))problem('请在原页面完成操作。',403);
      if(r.headers.get('Sec-Fetch-Site')==='cross-site'&&!pagesRequest(r))problem('请在原页面完成操作。',403);
    }
    const q=db(env);
    const auth=await identity(r,q);
    if(url.pathname==='/api/auth/me'&&r.method==='GET'){
      let clubs=[];
      if(auth.account)clubs=await q.all('SELECT c.id,c.name,m.nickname,CASE WHEN c.owner_id=m.id THEN 1 ELSE 0 END AS is_owner FROM members m JOIN clubs c ON c.id=m.club_id WHERE m.account_id=? ORDER BY m.created_at',auth.account.id);
      else if(auth.hash)clubs=await q.all('SELECT c.id,c.name,m.nickname,CASE WHEN c.owner_id=m.id THEN 1 ELSE 0 END AS is_owner FROM members m JOIN clubs c ON c.id=m.club_id WHERE m.session_hash=? AND m.account_id IS NULL ORDER BY m.created_at',auth.hash);
      return json({account:accountView(auth.account),clubs:clubs.map(c=>({id:c.id,name:c.name,nickname:c.nickname,isOwner:!!c.is_owner}))});
    }
    if(url.pathname==='/api/auth/login'&&r.method==='POST'){
      const b=await body(r),key=await authAttempt(r,q),canonical=normalizeRecoveryCode(b?.recoveryCode);
      const expectedHash=canonical?await digest(canonical):null,account=expectedHash?await q.one('SELECT id,display_name FROM accounts WHERE recovery_hash=?',expectedHash):null;
      if(!account)problem('私密登录码不正确，请检查后重试。',401);
      const response=await accountResponse(r,q,url,account,200,{},expectedHash);await clearAuthAttempts(q,key);return response;
    }
    if(url.pathname==='/api/auth/register'&&r.method==='POST'){
      const b=await body(r),nonce=b?.registrationNonce;
      if(typeof nonce!=='string'||!/^[a-f0-9]{64}$/.test(nonce))problem('登录准备未完成，请重新尝试。');
      let clubId=url.searchParams.get('club');
      if(clubId)id(clubId);else clubId=(await context(r,q,auth)).club.id;
      const nonceHash=await digest(nonce),now=Date.now();
      await q.run('DELETE FROM auth_registrations WHERE expires_at<=?',now);
      const legacyProof=auth.account?registrationLegacyCookie(r):auth.token,legacyHash=legacyProof?await digest(legacyProof):null;
      const receipt=legacyHash?await q.one('SELECT a.id,a.display_name,a.recovery_hash FROM auth_registrations g JOIN accounts a ON a.id=g.account_id JOIN members m ON m.club_id=g.club_id AND m.session_hash=g.legacy_hash AND m.account_id=g.account_id WHERE g.club_id=? AND g.legacy_hash=? AND g.nonce_hash=? AND g.expires_at>? AND (? IS NULL OR g.account_id=?)',clubId,legacyHash,nonceHash,now,auth.account?.id||null,auth.account?.id||null):null;
      if(receipt){
        const recovery=await registrationRecoveryCode(legacyProof,nonce,receipt.id);
        if(recovery.hash!==receipt.recovery_hash)problem('私密登录码已经更新，请使用新的登录码进入。',401);
        const legacyClubs=await q.all('SELECT c.id,c.name,m.nickname,CASE WHEN c.owner_id=m.id THEN 1 ELSE 0 END AS is_owner FROM members m JOIN clubs c ON c.id=m.club_id WHERE m.session_hash=? AND m.account_id IS NULL ORDER BY m.created_at',legacyHash);
        const remaining=legacyClubs.length?{legacySessionToken:legacyProof,legacyClubs:legacyClubs.map(c=>({id:c.id,name:c.name,nickname:c.nickname,isOwner:!!c.is_owner}))}:{};
        const resumed=await newAccountSession(receipt);
        const inserted=await q.run('INSERT INTO account_sessions(session_hash,account_id,expires_at,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM auth_registrations g JOIN accounts a ON a.id=g.account_id JOIN members m ON m.club_id=g.club_id AND m.session_hash=g.legacy_hash AND m.account_id=g.account_id WHERE g.account_id=? AND g.club_id=? AND g.legacy_hash=? AND g.nonce_hash=? AND g.expires_at>? AND a.recovery_hash=?)',resumed.hash,resumed.accountId,resumed.expiresAt,resumed.createdAt,receipt.id,clubId,legacyHash,nonceHash,Date.now(),recovery.hash);
        if(!inserted.meta.changes)problem('私密登录码或连接状态已经更新，请重新登录。',401);
        return accountSessionResponse(r,url,receipt,resumed.token,200,{...remaining,recoveryCode:recovery.code});
      }
      const c=await registerContext(r,q,auth),me=memberOnly(c);
      if(me.account_id||auth.account)problem('这张名片已经设置了登录，请直接登录。',409);
      const account={id:crypto.randomUUID(),display_name:me.nickname,created_at:new Date().toISOString()},recovery=await registrationRecoveryCode(auth.token,nonce,account.id);account.recovery_hash=recovery.hash;
      const first=await newAccountSession(account);
      const legacyClubs=await q.all('SELECT c.id,c.name,m.nickname,CASE WHEN c.owner_id=m.id THEN 1 ELSE 0 END AS is_owner FROM members m JOIN clubs c ON c.id=m.club_id WHERE m.session_hash=? AND m.account_id IS NULL AND m.id!=? ORDER BY m.created_at',auth.hash,me.id);
      const statements=[
        ['INSERT INTO accounts(id,display_name,recovery_hash,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM members WHERE id=? AND account_id IS NULL)',account.id,account.display_name,account.recovery_hash,account.created_at,me.id],
        ['UPDATE members SET account_id=? WHERE id=? AND club_id=? AND account_id IS NULL',account.id,me.id,c.club.id],
        ['INSERT INTO account_sessions(session_hash,account_id,expires_at,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM members WHERE id=? AND account_id=?)',first.hash,first.accountId,first.expiresAt,first.createdAt,me.id,account.id],
        ['INSERT INTO auth_registrations(account_id,club_id,legacy_hash,nonce_hash,expires_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM members WHERE id=? AND account_id=?)',account.id,c.club.id,auth.hash,nonceHash,now+REGISTRATION_RECEIPT_AGE,me.id,account.id]
      ];
      let saved;
      try{saved=await q.batch(statements);}catch(e){if(/UNIQUE constraint|idx_accounts_recovery_hash|idx_members_club_account/i.test(e.message))problem('名片刚刚发生变化，请重试；同群的不同名片不能合并。',409);throw e;}
      if(!saved[1].meta.changes)problem('这张名片已经设置了登录，请重新登录。',409);
      const remaining=legacyClubs.length?{legacySessionToken:auth.token,legacyClubs:legacyClubs.map(c=>({id:c.id,name:c.name,nickname:c.nickname,isOwner:!!c.is_owner}))}:{};
      return accountSessionResponse(r,url,account,first.token,200,{...remaining,recoveryCode:recovery.code},auth.token);
    }
    if(url.pathname==='/api/auth/bind'&&r.method==='POST'){
      if(!auth.account)problem('请先登录，再连接原来的名片。',401);
      const clubId=id(url.searchParams.get('club')),b=await body(r),legacyToken=b?.legacySessionToken;
      if(typeof legacyToken!=='string'||!/^[a-f0-9]{64}$/.test(legacyToken))problem('未找到这张原名片的有效证明，请在原来的浏览器里连接。',401);
      const me=await q.one('SELECT * FROM members WHERE club_id=? AND session_hash=? AND account_id IS NULL',clubId,await digest(legacyToken));
      if(!me)problem('未找到这张原名片的有效证明，请在原来的浏览器里连接。',401);
      const other=await q.one('SELECT id FROM members WHERE club_id=? AND account_id=?',clubId,auth.account.id);
      if(other&&other.id!==me.id)problem('这个账号在群里已有另一张名片，不能合并不同成员。',409);
      let bound;
      try{bound=await q.run('UPDATE members SET account_id=? WHERE id=? AND club_id=? AND account_id IS NULL',auth.account.id,me.id,clubId);}catch(e){if(/UNIQUE constraint|idx_members_club_account/i.test(e.message))problem('这个账号在群里已有另一张名片，不能合并不同成员。',409);throw e;}
      if(!bound.meta.changes)problem('这张名片刚刚设置了登录，请重新进入。',409);
      return json({account:accountView(auth.account),id:me.id});
    }
    if(url.pathname==='/api/auth/recovery'&&r.method==='POST'){
      if(!auth.account)problem('请先登录，再更新私密登录码。',401);
      await body(r);const recovery=await newRecoveryCode();
      await q.run('UPDATE accounts SET recovery_hash=? WHERE id=?',recovery.hash,auth.account.id);
      return json({recoveryCode:recovery.code});
    }
    if(url.pathname==='/api/auth/logout'&&r.method==='POST'){
      if(auth.hash)await q.run('DELETE FROM account_sessions WHERE session_hash=?',auth.hash);
      const response=json({ok:true},200,cookieHeader('',url,0));response.headers.append('Set-Cookie',registrationCookieHeader('',url,0));return response;
    }
    if(url.pathname==='/api/clubs'&&r.method==='POST'){
      const b=await body(r), name=str(b.name,24,true), slogan=str(b.slogan||'',80), nickname=str(b.nickname,20,true);
      const token=auth.token||secret(), sessionHash=await digest(auth.account?secret():token);
      const count=auth.account?await q.one('SELECT COUNT(*) AS n FROM members WHERE account_id=?',auth.account.id):await q.one('SELECT COUNT(*) AS n FROM members WHERE session_hash=? AND account_id IS NULL',sessionHash);
      if(Number(count.n)>=5)problem('你已经有 5 本群小本本了，先用现有的吧。');
      const invite=secret(),clubId=crypto.randomUUID(),memberId=crypto.randomUUID(),now=new Date().toISOString();
      await q.batch([
        ['INSERT INTO clubs(id,invite_hash,name,slogan,owner_id,created_at) VALUES(?,?,?,?,?,?)',clubId,await digest(invite),name,slogan,memberId,now],
        ['INSERT INTO members(id,club_id,session_hash,account_id,nickname,bio,created_at) VALUES(?,?,?,?,?,?,?)',memberId,clubId,sessionHash,auth.account?.id||null,nickname,'',now]
      ]);
      if(auth.account)return json({invite},201);
      return json(sessionResult({invite},token,r),201,cookieHeader(token,url));
    }
    const c=await context(r,q,auth);
    if(url.pathname==='/api/board'&&r.method==='GET'){
      const members=await q.all('SELECT m.id,m.nickname,m.bio,m.avatar_key,m.created_at,COUNT(r.id) AS record_count,COALESCE(SUM(r.minutes),0) AS minutes,COUNT(r.forehand) AS rated_count,AVG(r.forehand) AS avg_forehand,AVG(r.backhand) AS avg_backhand,AVG(r.serve) AS avg_serve,AVG(r.return_skill) AS avg_return_skill,AVG(r.net) AS avg_net,AVG(r.footwork) AS avg_footwork FROM members m LEFT JOIN records r ON r.member_id=m.id WHERE m.club_id=? GROUP BY m.id ORDER BY m.created_at',c.club.id);
      const records=await q.all('SELECT r.*,m.nickname FROM records r JOIN members m ON m.id=r.member_id WHERE r.club_id=? ORDER BY r.play_date DESC,r.created_at DESC LIMIT 500',c.club.id);
      const cheers=await q.all('SELECT h.record_id,h.member_id,h.emoji FROM cheers h JOIN records r ON r.id=h.record_id WHERE r.club_id=?',c.club.id);
      const culture=await q.all('SELECT p.*,m.nickname FROM culture p JOIN members m ON m.id=p.member_id WHERE p.club_id=? ORDER BY p.created_at DESC LIMIT 200',c.club.id);
      const totals=await q.one('SELECT COUNT(*) AS records,COALESCE(SUM(minutes),0) AS minutes FROM records WHERE club_id=?',c.club.id);
      const todayCheckins=await q.all('SELECT member_id FROM checkins WHERE club_id=? AND checkin_date=?',c.club.id,chinaDay());
      return json({club:{id:c.club.id,name:c.club.name,slogan:c.club.slogan,ownerId:c.club.owner_id},account:accountView(auth.account),me:c.me?.id||null,members:members.map(m=>({...m,hasAvatar:!!m.avatar_key,avatarVersion:m.avatar_key,avatar_key:undefined})),records,cheers,culture,totals,today:chinaDay(),todayCheckins:todayCheckins.map(x=>x.member_id)});
    }
    if(url.pathname==='/api/checkins'&&r.method==='POST'){
      const me=memberOnly(c),result=await q.batch([checkinStatement(c.club.id,me.id)]);
      return json({date:chinaDay(),alreadyChecked:!result[0].meta.changes});
    }
    if(url.pathname==='/api/growth'&&r.method==='GET'){
      const me=memberOnly(c),today=chinaDay(),month=url.searchParams.get('month')||today.slice(0,7),page=Number(url.searchParams.get('page')||0);
      if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||Number(month.slice(0,4))<1900||Number(month.slice(0,4))>2100||!Number.isInteger(page)||page<0||page>1000000)problem('请选择有效的月份和页码。');
      const start=`${month}-01`,end=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),1)).toISOString().slice(0,10);
      const summary=await q.one("SELECT COUNT(*) AS records,COALESCE(SUM(minutes),0) AS minutes,SUM(CASE WHEN training_projects!='[]' THEN 1 ELSE 0 END) AS training_sessions,COALESCE(SUM(CASE WHEN training_projects!='[]' THEN minutes ELSE 0 END),0) AS training_minutes,COUNT(DISTINCT CASE WHEN training_projects!='[]' THEN play_date END) AS training_days,MIN(play_date) AS first_date FROM records WHERE member_id=?",me.id);
      const checkinDates=await q.all('SELECT checkin_date FROM checkins WHERE member_id=? ORDER BY checkin_date DESC',me.id);
      const dates=new Set(checkinDates.map(x=>x.checkin_date));let cursor=dates.has(today)?today:shiftDay(today,-1),streak=0;while(dates.has(cursor)){streak++;cursor=shiftDay(cursor,-1);}
      const monthCheckins=checkinDates.filter(x=>x.checkin_date.startsWith(month)).map(x=>x.checkin_date);
      const trainingDays=await q.all("SELECT play_date,COUNT(*) AS sessions,SUM(minutes) AS minutes FROM records WHERE member_id=? AND training_projects!='[]' AND play_date>=? AND play_date<? GROUP BY play_date ORDER BY play_date",me.id,start,end);
      const records=await q.all('SELECT r.*,m.nickname FROM records r JOIN members m ON m.id=r.member_id WHERE r.member_id=? ORDER BY r.play_date DESC,r.created_at DESC LIMIT 20 OFFSET ?',me.id,page*20);
      const history=await q.all('SELECT SUBSTR(play_date,1,7) AS month,COUNT(*) AS samples,AVG(forehand) AS forehand,AVG(backhand) AS backhand,AVG(serve) AS serve,AVG(return_skill) AS return_skill,AVG(net) AS net,AVG(footwork) AS footwork,AVG(forehand+backhand+serve+return_skill+net+footwork) AS total FROM records WHERE member_id=? AND forehand IS NOT NULL GROUP BY SUBSTR(play_date,1,7) ORDER BY month',me.id);
      const nextPlan=await q.one("SELECT id,play_date,next_plan,training_projects FROM records WHERE member_id=? AND next_plan!='' ORDER BY play_date DESC,created_at DESC LIMIT 1",me.id);
      return json({today,month,page,pageSize:20,summary:{...summary,training_sessions:Number(summary.training_sessions||0),checkin_days:dates.size,streak,checkedToday:dates.has(today)},checkins:monthCheckins,trainingDays,records,history,nextPlan});
    }
    if(url.pathname==='/api/pages-session'&&r.method==='POST'){
      if(r.headers.get('Origin')!==url.origin||r.headers.has('X-Tennis-Session')||!cookie(r))problem('请从原页面连接自己的名片。',403);
      const me=memberOnly(c);if(auth.account||me.account_id)problem('这张名片已经设置账号，请在 GitHub 页面用私密登录码登录。',403);
      return json({sessionToken:cookie(r)});
    }
    if(url.pathname==='/api/invite'&&r.method==='POST'){
      memberOnly(c);const invite=secret();
      await q.run('INSERT INTO club_invites(invite_hash,club_id,created_at) VALUES(?,?,?)',await digest(invite),c.club.id,new Date().toISOString());
      return json({invite});
    }
    if(url.pathname==='/api/profile'&&r.method==='POST'){
      const b=await body(r),nickname=str(b.nickname,20,true),bio=str(b.bio||'',80);
      if(c.me){
        const updated=await q.run('UPDATE members SET nickname=?,bio=? WHERE id=? AND club_id=? AND (account_id IS NULL OR account_id=?)',nickname,bio,c.me.id,c.club.id,auth.account?.id||null);
        if(!updated.meta.changes)problem('这张名片的登录状态已变化，请重新登录。',401);
        return json({id:c.me.id});
      }
      const token=auth.token||secret(), sessionHash=await digest(auth.account?secret():token),memberId=crypto.randomUUID();
      if(auth.account){
        await q.run('INSERT INTO members(id,club_id,session_hash,account_id,nickname,bio,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(club_id,account_id) DO UPDATE SET nickname=excluded.nickname,bio=excluded.bio',memberId,c.club.id,sessionHash,auth.account.id,nickname,bio,new Date().toISOString());
        const saved=await q.one('SELECT id FROM members WHERE club_id=? AND account_id=?',c.club.id,auth.account.id);return json({id:saved.id},201);
      }
      const bound=await q.one('SELECT id FROM members WHERE club_id=? AND session_hash=? AND account_id IS NOT NULL',c.club.id,sessionHash);
      if(bound)problem('这张名片已经设置了登录，请用私密登录码登录。',401);
      await q.run('INSERT INTO members(id,club_id,session_hash,nickname,bio,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(club_id,session_hash) DO UPDATE SET nickname=excluded.nickname,bio=excluded.bio WHERE members.account_id IS NULL',memberId,c.club.id,sessionHash,nickname,bio,new Date().toISOString());
      const saved=await q.one('SELECT id,account_id FROM members WHERE club_id=? AND session_hash=?',c.club.id,sessionHash);
      if(saved.account_id)problem('这张名片已经设置了登录，请用私密登录码登录。',401);
      return json(sessionResult({id:saved.id},token,r),201,cookieHeader(token,url));
    }
    if(url.pathname==='/api/club'&&r.method==='PATCH'){
      const me=memberOnly(c);if(me.id!==c.club.owner_id)problem('只有创建小本本的球友可以修改群设置。',403);
      const b=await body(r);await q.run('UPDATE clubs SET name=?,slogan=? WHERE id=?',str(b.name,24,true),str(b.slogan||'',80),c.club.id);return json({ok:true});
    }
    if(url.pathname==='/api/avatar'&&r.method==='POST'){
      const me=memberOnly(c);if(!env.BUCKET)problem('头像暂时无法上传，请稍后再试。',503);
      if(Number(r.headers.get('Content-Length'))>2*1024*1024)problem('头像请小于 2MB。',413);
      const bytes=new Uint8Array(await r.arrayBuffer());if(bytes.length>2*1024*1024||bytes.length<12)problem('请选择小于 2MB 的 JPG、PNG 或 WebP 图片。');
      let type='';if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)type='image/jpeg';else if(bytes.slice(0,8).join(',')==='137,80,78,71,13,10,26,10')type='image/png';else if(String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP')type='image/webp';
      if(!type)problem('头像支持 JPG、PNG 和 WebP，请换张图片试试。');
      const key=`avatars/${c.club.id}/${me.id}/${crypto.randomUUID()}`;
      await env.BUCKET.put(key,bytes,{httpMetadata:{contentType:type}});
      try{await q.run('UPDATE members SET avatar_key=? WHERE id=?',key,me.id);}catch(e){await env.BUCKET.delete(key);throw e;}
      if(me.avatar_key){try{await env.BUCKET.delete(me.avatar_key);}catch(e){console.error('Old avatar cleanup failed');}}
      return json({ok:true});
    }
    if(url.pathname.startsWith('/api/avatar/')&&r.method==='GET'){
      const m=await q.one('SELECT avatar_key FROM members WHERE id=? AND club_id=?',id(url.pathname.split('/').pop()),c.club.id);
      if(!m?.avatar_key)return new Response(null,{status:404});if(!env.BUCKET)problem('头像暂时无法加载。',503);
      const file=await env.BUCKET.get(m.avatar_key);if(!file)return new Response(null,{status:404});
      return new Response(file.body,{headers:{'Content-Type':file.httpMetadata?.contentType||'image/jpeg','Cache-Control':'private, max-age=300','X-Content-Type-Options':'nosniff'}});
    }
    if(url.pathname==='/api/records'&&r.method==='POST'){
      const me=memberOnly(c),b=await body(r),v=recordInput(b),recordId=id(b.id),skills=skillInput(b),training=trainingInput(b);
      const statements=[['INSERT INTO records(id,club_id,member_id,play_date,minutes,partners,venue,mood,note,created_at,forehand,backhand,serve,return_skill,net,footwork,training_projects,training_content,training_effect,effect_note,next_plan) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',recordId,c.club.id,me.id,v.date,v.minutes,v.partners,v.venue,v.mood,v.note,new Date().toISOString(),...skills,...training]];
      if(v.date===chinaDay())statements.push(checkinStatement(c.club.id,me.id));
      await q.batch(statements);
      const saved=await q.one('SELECT member_id,club_id FROM records WHERE id=?',recordId);if(saved.member_id!==me.id||saved.club_id!==c.club.id)problem('记录编号冲突，请重新打开表单。',409);
      return json({id:recordId},201);
    }
    if(url.pathname.startsWith('/api/records/')){
      const me=memberOnly(c),recordId=id(url.pathname.split('/').pop()),record=await q.one('SELECT * FROM records WHERE id=? AND club_id=?',recordId,c.club.id);
      if(!record)problem('这场记录已经不在了。',404);if(record.member_id!==me.id)problem('只能修改自己的打球记录。',403);
      if(r.method==='DELETE'){await q.run('DELETE FROM records WHERE id=? AND member_id=?',recordId,me.id);return json({ok:true});}
      if(r.method==='PATCH'){const b=await body(r),v=recordInput(b),skills=skillInput(b,record),training=trainingInput(b,record);const statements=[['UPDATE records SET play_date=?,minutes=?,partners=?,venue=?,mood=?,note=?,forehand=?,backhand=?,serve=?,return_skill=?,net=?,footwork=?,training_projects=?,training_content=?,training_effect=?,effect_note=?,next_plan=? WHERE id=? AND member_id=?',v.date,v.minutes,v.partners,v.venue,v.mood,v.note,...skills,...training,recordId,me.id]];if(v.date===chinaDay())statements.push(checkinStatement(c.club.id,me.id));await q.batch(statements);return json({ok:true});}
    }
    if(url.pathname==='/api/cheers'&&r.method==='POST'){
      const me=memberOnly(c),b=await body(r),recordId=id(b.recordId);if(!EMOJIS.includes(b.emoji))problem('请选择页面中的表情。');
      if(!await q.one('SELECT id FROM records WHERE id=? AND club_id=?',recordId,c.club.id))problem('这场记录已经不在了。',404);
      const prior=await q.one('SELECT emoji FROM cheers WHERE record_id=? AND member_id=?',recordId,me.id);
      if(prior?.emoji===b.emoji)await q.run('DELETE FROM cheers WHERE record_id=? AND member_id=?',recordId,me.id);
      else await q.run('INSERT INTO cheers(record_id,member_id,emoji) VALUES(?,?,?) ON CONFLICT(record_id,member_id) DO UPDATE SET emoji=excluded.emoji',recordId,me.id,b.emoji);
      return json({ok:true});
    }
    if(url.pathname==='/api/culture'&&r.method==='POST'){
      const me=memberOnly(c),b=await body(r),cultureId=id(b.id),content=str(b.content,160,true);
      await q.run('INSERT INTO culture(id,club_id,member_id,content,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING',cultureId,c.club.id,me.id,content,new Date().toISOString());return json({id:cultureId},201);
    }
    if(url.pathname.startsWith('/api/culture/')&&r.method==='DELETE'){
      const me=memberOnly(c),postId=id(url.pathname.split('/').pop()),post=await q.one('SELECT member_id FROM culture WHERE id=? AND club_id=?',postId,c.club.id);if(!post)problem('这条群内梗已经不在了。',404);if(post.member_id!==me.id)problem('只能删除自己发布的群内梗。',403);await q.run('DELETE FROM culture WHERE id=? AND member_id=?',postId,me.id);return json({ok:true});
    }
    return json({error:'这个操作暂时不可用。'},404);
  }catch(e){if(!e.status)console.error('Tennis request failed',url.pathname,e.message);return json({error:e.status?e.message:'小本本暂时忙不过来，内容还在，请稍后重试。'},e.status||503);}}
};

export default {
  async fetch(r,env){
    const path=new URL(r.url).pathname,isApi=path.startsWith('/api/'),isBridge=path==='/api/pages-session';
    const allowed=pagesRequest(r)&&!isBridge;
    if(r.method==='OPTIONS'&&isApi){
      const method=r.headers.get('Access-Control-Request-Method');
      const headers=(r.headers.get('Access-Control-Request-Headers')||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
      if(!allowed||!['GET','POST','PATCH','DELETE'].includes(method)||headers.some(x=>!['authorization','content-type','x-tennis-session'].includes(x)))return new Response(null,{status:403,headers:{Vary:'Origin'}});
      return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':PAGES_ORIGIN,'Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type,X-Tennis-Session','Access-Control-Max-Age':'600',Vary:'Origin'}});
    }
    const response=await handler.fetch(r,env);
    if(!isApi)return response;
    const headers=new Headers(response.headers);headers.append('Vary','Origin');
    if(allowed)headers.set('Access-Control-Allow-Origin',PAGES_ORIGIN);
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  }
};
