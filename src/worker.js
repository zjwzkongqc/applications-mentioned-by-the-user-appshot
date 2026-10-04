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
  if(!b.skills||typeof b.skills!=='object'||Array.isArray(b.skills)||Object.keys(b.skills).length!==6||SKILLS.some(k=>b.skills[k]!==null&&(!Number.isInteger(b.skills[k])||b.skills[k]<0||b.skills[k]>10)))problem('每项请选择 0–10 分，或保留待测。');
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
function emailInput(value){const email=str(value,254,true).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))problem('请填写有效的邮箱地址。');return email;}
function passwordInput(value){if(typeof value!=='string'||value.length<10||value.length>128)problem('密码请使用 10–128 个字符。');return value;}
async function passwordHash(password,salt){const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);return [...new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',salt:encoder.encode(salt),iterations:100000,hash:'SHA-256'},key,256))].map(x=>x.toString(16).padStart(2,'0')).join('');}
function equalSecret(a,b){if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
function ownerOnly(c){const me=memberOnly(c);if(me.id!==c.club.owner_id)problem('只有小组管理员可以进行这个操作。',403);return me;}
function monthInput(value){const month=str(value,7,true);if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month<'1900-01'||month>chinaDay().slice(0,7))problem('请选择有效且已经开始的月份。');return month;}
function auditStatement(c,action,target,details={}){return ['INSERT INTO audit_events(id,club_id,actor_member_id,action,target_id,details,created_at) VALUES(?,?,?,?,?,?,?)',crypto.randomUUID(),c.club.id,c.me.id,action,target,JSON.stringify(details),new Date().toISOString()];}
function imageInput(bytes){if(bytes.length>2*1024*1024||bytes.length<12)problem('请选择小于 2MB 的 JPG、PNG 或 WebP 图片。',413);if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';if(bytes.slice(0,8).join(',')==='137,80,78,71,13,10,26,10')return 'image/png';if(String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP')return 'image/webp';problem('图片支持 JPG、PNG 和 WebP。');}
async function uploadBytes(r){if(Number(r.headers.get('Content-Length'))>2*1024*1024)problem('图片请小于 2MB。',413);const reader=r.body?.getReader(),chunks=[];let size=0;if(!reader)problem('请选择图片。');for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024){await reader.cancel();problem('图片请小于 2MB。',413);}chunks.push(value);}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return {bytes,type:imageInput(bytes)};}
async function imageResponse(env,key){if(!env.BUCKET)problem('图片暂时无法加载。',503);const file=await env.BUCKET.get(key);if(!file)return new Response(null,{status:404});return new Response(file.body,{headers:{'Content-Type':file.httpMetadata?.contentType||'image/jpeg','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
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
    club=await q.one('SELECT * FROM clubs WHERE invite_hash=? AND invite_revoked_at IS NULL',hash)||await q.one('SELECT c.* FROM club_invites i JOIN clubs c ON c.id=i.club_id WHERE i.invite_hash=? AND i.revoked_at IS NULL AND (i.expires_at=0 OR i.expires_at>?)',hash,Date.now());
    if(!club)problem('邀请链接无效，请向群友要一个新链接。',404);
  }else if(clubId){
    id(clubId);if(!auth.account&&!auth.hash)problem('请先登录，再进入自己的群小本本。',401);
    me=auth.account?await q.one('SELECT * FROM members WHERE club_id=? AND account_id=? AND removed_at IS NULL',clubId,auth.account.id):await q.one('SELECT * FROM members WHERE club_id=? AND session_hash=? AND account_id IS NULL AND removed_at IS NULL',clubId,auth.hash);
    if(!me)problem(auth.account?'这个账号还未加入这本小本本，请通过群邀请链接进入。':'请先登录，再进入自己的群小本本。',auth.account?403:401);
    club=await q.one('SELECT * FROM clubs WHERE id=?',clubId);
  }else problem('请从群里的邀请链接进入。',401);
  if(!me&&auth.account)me=await q.one('SELECT * FROM members WHERE club_id=? AND account_id=? AND removed_at IS NULL',club.id,auth.account.id);
  if(!me&&!auth.account&&auth.hash)me=await q.one('SELECT * FROM members WHERE club_id=? AND session_hash=? AND account_id IS NULL AND removed_at IS NULL',club.id,auth.hash);
  return {club,me,account:auth.account};
}
async function registerContext(r,q,auth){
  const clubId=new URL(r.url).searchParams.get('club');
  if(!r.headers.has('Authorization')&&clubId&&!auth.account){
    id(clubId);const me=auth.hash?await q.one('SELECT * FROM members WHERE club_id=? AND session_hash=? AND account_id IS NULL AND removed_at IS NULL',clubId,auth.hash):null;
    if(!me)problem('请在原来建立名片的浏览器里设置登录。',401);
    return {me,club:await q.one('SELECT * FROM clubs WHERE id=?',clubId)};
  }
  return context(r,q,auth);
}
function memberOnly(c){if(!c.me)problem('先取个昵称，加入球友名片吧。',401);return c.me;}
async function publicRoutes(r,env,q,url){
  const match=url.pathname.match(/^\/api\/public\/(card|avatar)\/([a-f0-9]{64})$/);
  if(!match||r.method!=='GET')return null;
  const member=await q.one('SELECT id,nickname,bio,avatar_key FROM members WHERE public_share_hash=? AND removed_at IS NULL',await digest(match[2]));
  if(!member)problem('这张球员卡没有公开，或分享已经撤回。',404);
  if(match[1]==='avatar')return member.avatar_key?imageResponse(env,member.avatar_key):new Response(null,{status:404});
  const rating=await q.one('SELECT month,forehand,backhand,serve,return_skill,net,footwork FROM monthly_ratings WHERE member_id=? ORDER BY month DESC LIMIT 1',member.id);
  return json({nickname:member.nickname,bio:member.bio,hasAvatar:!!member.avatar_key,rating:rating||null});
}
async function privateRoutes(r,env,q,c,url){
  const me=memberOnly(c),path=url.pathname;
    if(path==='/api/ratings'&&r.method==='GET'){
      const target=url.searchParams.get('memberId')?id(url.searchParams.get('memberId')):me.id;if(target!==me.id){ownerOnly(c);if(!await q.one('SELECT id FROM members WHERE id=? AND club_id=?',target,c.club.id))problem('成员不存在。',404);}
      return json({ratings:await q.all('SELECT month,forehand,backhand,serve,return_skill,net,footwork,updated_at FROM monthly_ratings WHERE member_id=? ORDER BY month DESC',target)});
    }
  if(path==='/api/ratings'&&r.method==='POST'){
    const b=await body(r),month=monthInput(b.month),scores=skillInput({skills:b.skills}),now=new Date().toISOString(),target=b.memberId? id(b.memberId):me.id;
    if(target!==me.id){ownerOnly(c);if(!await q.one('SELECT id FROM members WHERE id=? AND club_id=? AND removed_at IS NULL',target,c.club.id))problem('成员不存在。',404);}
    const before=await q.one('SELECT * FROM monthly_ratings WHERE member_id=? AND month=?',target,month);
    const statements=[['INSERT INTO monthly_ratings(member_id,month,forehand,backhand,serve,return_skill,net,footwork,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(member_id,month) DO UPDATE SET forehand=excluded.forehand,backhand=excluded.backhand,serve=excluded.serve,return_skill=excluded.return_skill,net=excluded.net,footwork=excluded.footwork,updated_at=excluded.updated_at',target,month,...scores,now,now]];
    if(target!==me.id)statements.push(auditStatement(c,'edit-rating',target,{month,before:before?Object.fromEntries(SKILLS.map(k=>[k,before[k]])):null,after:b.skills}));
    await q.batch(statements);return json({ok:true,month});
  }
  if(path==='/api/share'&&r.method==='POST'){
    const b=await body(r);if(typeof b.enabled!=='boolean')problem('请选择是否公开这张球员卡。');
    const token=b.enabled?secret():null;await q.run('UPDATE members SET public_share_hash=? WHERE id=? AND removed_at IS NULL',token?await digest(token):null,me.id);
    return json({enabled:b.enabled,token});
  }
  if(path==='/api/admin'&&r.method==='GET'){
    ownerOnly(c);
    const root={id:'original',created_at:c.club.created_at,revoked_at:c.club.invite_revoked_at,expires_at:0};
    const invites=await q.all('SELECT invite_hash AS id,created_at,revoked_at,expires_at FROM club_invites WHERE club_id=? ORDER BY created_at DESC',c.club.id);
    const members=await q.all('SELECT id,nickname,bio,removed_at FROM members WHERE club_id=? ORDER BY created_at',c.club.id);
    const events=await q.all('SELECT a.id,a.actor_member_id,m.nickname AS actor,a.action,a.target_id,a.details,a.created_at FROM audit_events a JOIN members m ON m.id=a.actor_member_id WHERE a.club_id=? ORDER BY a.created_at DESC LIMIT 100',c.club.id);
    return json({invites:[root,...invites],members,events});
  }
  const inviteMatch=path.match(/^\/api\/invites\/(original|[a-f0-9]{64})$/);
  if(inviteMatch&&r.method==='DELETE'){
    ownerOnly(c);const now=new Date().toISOString(),target=inviteMatch[1];
    const change=target==='original'?['UPDATE clubs SET invite_revoked_at=? WHERE id=?',now,c.club.id]:['UPDATE club_invites SET revoked_at=? WHERE invite_hash=? AND club_id=?',now,target,c.club.id];
    await q.batch([change,auditStatement(c,'revoke-invite',target==='original'?'original':'additional')]);return json({ok:true});
  }
  const memberMatch=path.match(/^\/api\/members\/([a-f0-9-]{36})(\/profile)?$/);
  if(memberMatch){
    ownerOnly(c);const target=id(memberMatch[1]),member=await q.one('SELECT * FROM members WHERE id=? AND club_id=?',target,c.club.id);if(!member)problem('成员不存在。',404);
    if(memberMatch[2]&&r.method==='POST'){
      const b=await body(r),nickname=str(b.nickname,20,true),bio=str(b.bio||'',80);
      await q.batch([['UPDATE members SET nickname=?,bio=? WHERE id=? AND club_id=?',nickname,bio,target,c.club.id],auditStatement(c,'edit-profile',target,{before:{nickname:member.nickname,bio:member.bio},after:{nickname,bio}})]);return json({ok:true});
    }
    if(!memberMatch[2]&&['DELETE','PATCH'].includes(r.method)){
      if(target===c.club.owner_id)problem('管理员不能移除自己的成员身份。');
      const removed=r.method==='DELETE'?new Date().toISOString():null;
      await q.batch([['UPDATE members SET removed_at=?,public_share_hash=NULL WHERE id=? AND club_id=?',removed,target,c.club.id],auditStatement(c,removed?'remove-member':'restore-member',target)]);return json({ok:true});
    }
  }
  const upload=path.match(/^\/api\/records\/([a-f0-9-]{36})\/photos$/);
  if(upload&&r.method==='POST'){
    const recordId=id(upload[1]),record=await q.one('SELECT member_id FROM records WHERE id=? AND club_id=?',recordId,c.club.id);if(!record)problem('打球记录不存在。',404);if(record.member_id!==me.id)problem('只能给自己的记录上传照片。',403);
    if(!env.BUCKET)problem('照片暂时无法上传。',503);
    const count=await q.one('SELECT COUNT(*) AS n FROM record_photos WHERE record_id=?',recordId);if(Number(count.n)>=3)problem('每场最多保留 3 张照片。');
    const {bytes,type}=await uploadBytes(r),photoId=crypto.randomUUID(),key=`photos/${c.club.id}/${me.id}/${photoId}`;
    await env.BUCKET.put(key,bytes,{httpMetadata:{contentType:type}});
    try{const inserted=await q.run('INSERT INTO record_photos(id,club_id,member_id,record_id,object_key,content_type,byte_size,created_at) SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM record_photos WHERE record_id=?)<3 AND EXISTS(SELECT 1 FROM members WHERE id=? AND removed_at IS NULL)',photoId,c.club.id,me.id,recordId,key,type,bytes.length,new Date().toISOString(),recordId,me.id);if(!inserted.meta.changes)problem('照片数量或成员权限已变化，请刷新后重试。',409);}catch(e){await env.BUCKET.delete(key);throw e;}
    return json({id:photoId},201);
  }
  const photo=path.match(/^\/api\/photos\/([a-f0-9-]{36})$/);
  if(photo){
    const item=await q.one('SELECT * FROM record_photos WHERE id=? AND club_id=?',id(photo[1]),c.club.id);if(!item)problem('照片不存在。',404);
    if(r.method==='GET')return imageResponse(env,item.object_key);
    if(r.method==='DELETE'){
      if(item.member_id!==me.id)ownerOnly(c);
      const statements=[['DELETE FROM record_photos WHERE id=? AND club_id=?',item.id,c.club.id]];if(item.member_id!==me.id)statements.push(auditStatement(c,'delete-photo',item.id));
      await q.batch(statements);if(env.BUCKET)await env.BUCKET.delete(item.object_key);return json({ok:true});
    }
  }
  if(path==='/api/export'&&r.method==='GET'){
    ownerOnly(c);await q.batch([auditStatement(c,'export-backup',c.club.id)]);
    const members=await q.all('SELECT id,nickname,bio,avatar_key,removed_at,created_at FROM members WHERE club_id=?',c.club.id);
    const records=await q.all('SELECT * FROM records WHERE club_id=? ORDER BY play_date,created_at',c.club.id);
    const ratings=await q.all('SELECT r.* FROM monthly_ratings r JOIN members m ON m.id=r.member_id WHERE m.club_id=? ORDER BY r.month',c.club.id);
    const culture=await q.all('SELECT * FROM culture WHERE club_id=?',c.club.id),checkins=await q.all('SELECT * FROM checkins WHERE club_id=?',c.club.id);
    const cheers=await q.all('SELECT c.* FROM cheers c JOIN records r ON r.id=c.record_id WHERE r.club_id=?',c.club.id),photos=await q.all('SELECT * FROM record_photos WHERE club_id=?',c.club.id),audit=await q.all('SELECT * FROM audit_events WHERE club_id=? ORDER BY created_at',c.club.id);
    async function* backup(){
      yield {kind:'club-backup',version:1,exportedAt:new Date().toISOString(),club:{id:c.club.id,name:c.club.name,slogan:c.club.slogan,ownerId:c.club.owner_id},members,records,ratings,culture,checkins,cheers,photos,audit};
      for(const media of [...members.filter(m=>m.avatar_key).map(m=>({key:m.avatar_key,memberId:m.id,kind:'avatar'})),...photos.map(p=>({key:p.object_key,photoId:p.id,kind:'photo'}))]){
        const file=env.BUCKET?await env.BUCKET.get(media.key):null;
        if(!file){yield {...media,missing:true};continue;}
        const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
        yield {...media,contentType:file.httpMetadata?.contentType||'image/jpeg',base64:btoa(binary)};
      }
    }
    const iterator=backup(),stream=new ReadableStream({async pull(controller){try{const next=await iterator.next();if(next.done)controller.close();else controller.enqueue(encoder.encode(JSON.stringify(next.value)+'\n'));}catch(e){controller.error(e);}},async cancel(){await iterator.return();}});
    return new Response(stream,{headers:{'Content-Type':'application/x-ndjson; charset=utf-8','Content-Disposition':`attachment; filename="tennis-backup-${chinaDay()}.ndjson"`,'Cache-Control':'no-store'}});
  }
  return null;
}
const handler = {
  async fetch(r,env){const url=new URL(r.url);try{
    if(r.method==='GET' && !url.pathname.startsWith('/api/')){
      const security={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com"};
      if(url.pathname==='/app.js')return new Response(JS,{headers:{...security,'Content-Type':'text/javascript; charset=utf-8'}});
      if(url.pathname==='/hexagon.js')return new Response(HEX_JS,{headers:{...security,'Content-Type':'text/javascript; charset=utf-8'}});
      if(url.pathname==='/growth.js')return new Response(GROWTH_JS,{headers:{...security,'Content-Type':'text/javascript; charset=utf-8'}});
      if(url.pathname==='/club-ui.js')return new Response(CLUB_JS,{headers:{...security,'Content-Type':'text/javascript; charset=utf-8'}});
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
      if(auth.account)clubs=await q.all('SELECT c.id,c.name,m.nickname,CASE WHEN c.owner_id=m.id THEN 1 ELSE 0 END AS is_owner FROM members m JOIN clubs c ON c.id=m.club_id WHERE m.account_id=? AND m.removed_at IS NULL ORDER BY m.created_at',auth.account.id);
      else if(auth.hash)clubs=await q.all('SELECT c.id,c.name,m.nickname,CASE WHEN c.owner_id=m.id THEN 1 ELSE 0 END AS is_owner FROM members m JOIN clubs c ON c.id=m.club_id WHERE m.session_hash=? AND m.account_id IS NULL AND m.removed_at IS NULL ORDER BY m.created_at',auth.hash);
      const credentials=auth.account?await q.one('SELECT email FROM account_credentials WHERE account_id=?',auth.account.id):null;
      return json({account:auth.account?{...accountView(auth.account),hasEmail:!!credentials}:null,clubs:clubs.map(c=>({id:c.id,name:c.name,nickname:c.nickname,isOwner:!!c.is_owner}))});
    }
    if(url.pathname==='/api/auth/signup'&&r.method==='POST'){
      if(auth.hash&&!auth.account&&await q.one('SELECT id FROM members WHERE session_hash=? AND account_id IS NULL AND removed_at IS NULL',auth.hash))problem('本设备已有原名片，请先保存原身份，再绑定邮箱和密码。',409);
      const b=await body(r),key=await authAttempt(r,q),email=emailInput(b.email),password=passwordInput(b.password),salt=secret(16),now=new Date().toISOString();
      const account={id:crypto.randomUUID(),display_name:str(b.nickname,20,true)},recovery=await newRecoveryCode(),first=await newAccountSession(account);
      const hashed=await passwordHash(password,salt);
      try{await q.batch([
        ['INSERT INTO accounts(id,display_name,recovery_hash,created_at) VALUES(?,?,?,?)',account.id,account.display_name,recovery.hash,now],
        ['INSERT INTO account_credentials(account_id,email,password_hash,password_salt,updated_at) VALUES(?,?,?,?,?)',account.id,email,hashed,salt,now],
        ['INSERT INTO account_sessions(session_hash,account_id,expires_at,created_at) VALUES(?,?,?,?)',first.hash,first.accountId,first.expiresAt,first.createdAt]
      ]);}catch(e){if(/UNIQUE constraint|idx_account_credentials_email/.test(e.message))problem('这个邮箱已经注册，请登录或使用本人恢复码。',409);throw e;}
      await clearAuthAttempts(q,key);return accountSessionResponse(r,url,account,first.token,201,{recoveryCode:recovery.code});
    }
    if(url.pathname==='/api/auth/credentials'&&r.method==='POST'){
      if(!auth.account)problem('请先登录，再设置邮箱和密码。',401);
      const b=await body(r),email=emailInput(b.email),password=passwordInput(b.password),salt=secret(16),hashed=await passwordHash(password,salt);
      try{await q.run('INSERT INTO account_credentials(account_id,email,password_hash,password_salt,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET email=excluded.email,password_hash=excluded.password_hash,password_salt=excluded.password_salt,updated_at=excluded.updated_at',auth.account.id,email,hashed,salt,new Date().toISOString());}catch(e){if(/UNIQUE constraint|idx_account_credentials_email/.test(e.message))problem('这个邮箱已用于另一个账号。',409);throw e;}
      return json({ok:true});
    }
    if(url.pathname==='/api/auth/login'&&r.method==='POST'){
      const b=await body(r),key=await authAttempt(r,q);
      if(Object.prototype.hasOwnProperty.call(b,'email')){
        const email=typeof b.email==='string'?b.email.trim().toLowerCase():'',password=typeof b.password==='string'&&b.password.length<=128?b.password:'';
        const row=await q.one('SELECT a.id,a.display_name,c.password_hash,c.password_salt FROM account_credentials c JOIN accounts a ON a.id=c.account_id WHERE c.email=?',email);
        const hashed=await passwordHash(password,row?.password_salt||'0'.repeat(32));if(!row||!equalSecret(hashed,row.password_hash))problem('邮箱或密码不正确，请检查后重试。',401);
        const first=await newAccountSession(row),inserted=await q.run('INSERT INTO account_sessions(session_hash,account_id,expires_at,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM account_credentials WHERE account_id=? AND password_hash=? AND password_salt=?)',first.hash,first.accountId,first.expiresAt,first.createdAt,row.id,row.password_hash,row.password_salt);
        if(!inserted.meta.changes)problem('邮箱或密码已更新，请重新登录。',401);
        await clearAuthAttempts(q,key);return accountSessionResponse(r,url,row,first.token);
      }
      const canonical=normalizeRecoveryCode(b?.recoveryCode);
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
      const receipt=legacyHash?await q.one('SELECT a.id,a.display_name,a.recovery_hash FROM auth_registrations g JOIN accounts a ON a.id=g.account_id JOIN members m ON m.club_id=g.club_id AND m.session_hash=g.legacy_hash AND m.account_id=g.account_id AND m.removed_at IS NULL WHERE g.club_id=? AND g.legacy_hash=? AND g.nonce_hash=? AND g.expires_at>? AND (? IS NULL OR g.account_id=?)',clubId,legacyHash,nonceHash,now,auth.account?.id||null,auth.account?.id||null):null;
      if(receipt){
        const recovery=await registrationRecoveryCode(legacyProof,nonce,receipt.id);
        if(recovery.hash!==receipt.recovery_hash)problem('私密登录码已经更新，请使用新的登录码进入。',401);
        const legacyClubs=await q.all('SELECT c.id,c.name,m.nickname,CASE WHEN c.owner_id=m.id THEN 1 ELSE 0 END AS is_owner FROM members m JOIN clubs c ON c.id=m.club_id WHERE m.session_hash=? AND m.account_id IS NULL AND m.removed_at IS NULL ORDER BY m.created_at',legacyHash);
        const remaining=legacyClubs.length?{legacySessionToken:legacyProof,legacyClubs:legacyClubs.map(c=>({id:c.id,name:c.name,nickname:c.nickname,isOwner:!!c.is_owner}))}:{};
        const resumed=await newAccountSession(receipt);
        const inserted=await q.run('INSERT INTO account_sessions(session_hash,account_id,expires_at,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM auth_registrations g JOIN accounts a ON a.id=g.account_id JOIN members m ON m.club_id=g.club_id AND m.session_hash=g.legacy_hash AND m.account_id=g.account_id AND m.removed_at IS NULL WHERE g.account_id=? AND g.club_id=? AND g.legacy_hash=? AND g.nonce_hash=? AND g.expires_at>? AND a.recovery_hash=?)',resumed.hash,resumed.accountId,resumed.expiresAt,resumed.createdAt,receipt.id,clubId,legacyHash,nonceHash,Date.now(),recovery.hash);
        if(!inserted.meta.changes)problem('私密登录码或连接状态已经更新，请重新登录。',401);
        return accountSessionResponse(r,url,receipt,resumed.token,200,{...remaining,recoveryCode:recovery.code});
      }
      const c=await registerContext(r,q,auth),me=memberOnly(c);
      if(me.account_id||auth.account)problem('这张名片已经设置了登录，请直接登录。',409);
      const account={id:crypto.randomUUID(),display_name:me.nickname,created_at:new Date().toISOString()},recovery=await registrationRecoveryCode(auth.token,nonce,account.id);account.recovery_hash=recovery.hash;
      const first=await newAccountSession(account);
      const legacyClubs=await q.all('SELECT c.id,c.name,m.nickname,CASE WHEN c.owner_id=m.id THEN 1 ELSE 0 END AS is_owner FROM members m JOIN clubs c ON c.id=m.club_id WHERE m.session_hash=? AND m.account_id IS NULL AND m.removed_at IS NULL AND m.id!=? ORDER BY m.created_at',auth.hash,me.id);
      const statements=[
        ['INSERT INTO accounts(id,display_name,recovery_hash,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM members WHERE id=? AND account_id IS NULL AND removed_at IS NULL)',account.id,account.display_name,account.recovery_hash,account.created_at,me.id],
        ['UPDATE members SET account_id=? WHERE id=? AND club_id=? AND account_id IS NULL AND removed_at IS NULL',account.id,me.id,c.club.id],
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
      const me=await q.one('SELECT * FROM members WHERE club_id=? AND session_hash=? AND account_id IS NULL AND removed_at IS NULL',clubId,await digest(legacyToken));
      if(!me)problem('未找到这张原名片的有效证明，请在原来的浏览器里连接。',401);
      const other=await q.one('SELECT id FROM members WHERE club_id=? AND account_id=? AND removed_at IS NULL',clubId,auth.account.id);
      if(other&&other.id!==me.id)problem('这个账号在群里已有另一张名片，不能合并不同成员。',409);
      let bound;
      try{bound=await q.run('UPDATE members SET account_id=? WHERE id=? AND club_id=? AND account_id IS NULL AND removed_at IS NULL',auth.account.id,me.id,clubId);}catch(e){if(/UNIQUE constraint|idx_members_club_account/i.test(e.message))problem('这个账号在群里已有另一张名片，不能合并不同成员。',409);throw e;}
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
      if(!auth.account)problem('请先注册或登录，再创建小组。',401);
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
    const publicResponse=await publicRoutes(r,env,q,url);if(publicResponse)return publicResponse;
    const c=await context(r,q,auth);
    if(url.pathname==='/api/invitation'&&r.method==='GET')return json({club:{id:c.club.id,name:c.club.name,slogan:c.club.slogan},joined:!!c.me,legacy:!!c.me&&!auth.account});
    if(url.pathname==='/api/profile'&&r.method==='POST'&&!c.me){
      if(!auth.account)problem('请先注册或登录，再加入小组。',401);
      const previous=await q.one('SELECT id,removed_at FROM members WHERE club_id=? AND account_id=?',c.club.id,auth.account.id);if(previous?.removed_at)problem('你的成员权限已被移除，请联系管理员恢复。',403);
      const b=await body(r),nickname=str(b.nickname,20,true),bio=str(b.bio||'',80),memberId=crypto.randomUUID();
      await q.run('INSERT INTO members(id,club_id,session_hash,account_id,nickname,bio,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(club_id,account_id) DO NOTHING',memberId,c.club.id,await digest(secret()),auth.account.id,nickname,bio,new Date().toISOString());
      const saved=await q.one('SELECT id FROM members WHERE club_id=? AND account_id=? AND removed_at IS NULL',c.club.id,auth.account.id);if(!saved)problem('成员状态已经变化，请联系管理员。',403);return json({id:saved.id},201);
    }
    memberOnly(c);
    const privateResponse=await privateRoutes(r,env,q,c,url);if(privateResponse)return privateResponse;
    if(url.pathname==='/api/board'&&r.method==='GET'){
      const members=await q.all('SELECT m.id,m.nickname,m.bio,m.avatar_key,m.created_at,(m.public_share_hash IS NOT NULL) AS public_shared,COUNT(r.id) AS record_count,COALESCE(SUM(r.minutes),0) AS minutes,SUM(CASE WHEN r.forehand IS NOT NULL OR r.backhand IS NOT NULL OR r.serve IS NOT NULL OR r.return_skill IS NOT NULL OR r.net IS NOT NULL OR r.footwork IS NOT NULL THEN 1 ELSE 0 END) AS rated_count,AVG(r.forehand) AS avg_forehand,AVG(r.backhand) AS avg_backhand,AVG(r.serve) AS avg_serve,AVG(r.return_skill) AS avg_return_skill,AVG(r.net) AS avg_net,AVG(r.footwork) AS avg_footwork FROM members m LEFT JOIN records r ON r.member_id=m.id WHERE m.club_id=? AND m.removed_at IS NULL GROUP BY m.id ORDER BY m.created_at',c.club.id);
      const records=await q.all('SELECT r.*,m.nickname FROM records r JOIN members m ON m.id=r.member_id WHERE r.club_id=? ORDER BY r.play_date DESC,r.created_at DESC LIMIT 500',c.club.id);
      const cheers=await q.all('SELECT h.record_id,h.member_id,h.emoji FROM cheers h JOIN records r ON r.id=h.record_id WHERE r.club_id=?',c.club.id);
      const culture=await q.all('SELECT p.*,m.nickname FROM culture p JOIN members m ON m.id=p.member_id WHERE p.club_id=? ORDER BY p.created_at DESC LIMIT 200',c.club.id);
      const totals=await q.one('SELECT COUNT(*) AS records,COALESCE(SUM(minutes),0) AS minutes FROM records WHERE club_id=?',c.club.id);
      const todayCheckins=await q.all('SELECT member_id FROM checkins WHERE club_id=? AND checkin_date=?',c.club.id,chinaDay());
      const monthly=await q.all('SELECT x.* FROM monthly_ratings x JOIN members m ON m.id=x.member_id WHERE m.club_id=? ORDER BY x.month DESC',c.club.id);
      const photos=await q.all('SELECT id,record_id,member_id,created_at FROM record_photos WHERE club_id=?',c.club.id);
      return json({club:{id:c.club.id,name:c.club.name,slogan:c.club.slogan,ownerId:c.club.owner_id},account:accountView(auth.account),me:c.me.id,members:members.map(m=>({...m,rating:monthly.find(x=>x.member_id===m.id)||null,hasAvatar:!!m.avatar_key,avatarVersion:m.avatar_key,avatar_key:undefined})),records,photos,cheers,culture,totals,today:chinaDay(),todayCheckins:todayCheckins.map(x=>x.member_id)});
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
      const history=await q.all('SELECT SUBSTR(play_date,1,7) AS month,COUNT(*) AS samples,COUNT(forehand) AS samples_forehand,COUNT(backhand) AS samples_backhand,COUNT(serve) AS samples_serve,COUNT(return_skill) AS samples_return_skill,COUNT(net) AS samples_net,COUNT(footwork) AS samples_footwork,AVG(forehand) AS forehand,AVG(backhand) AS backhand,AVG(serve) AS serve,AVG(return_skill) AS return_skill,AVG(net) AS net,AVG(footwork) AS footwork,AVG(forehand+backhand+serve+return_skill+net+footwork) AS total FROM records WHERE member_id=? AND (forehand IS NOT NULL OR backhand IS NOT NULL OR serve IS NOT NULL OR return_skill IS NOT NULL OR net IS NOT NULL OR footwork IS NOT NULL) GROUP BY SUBSTR(play_date,1,7) ORDER BY month',me.id);
      const nextPlan=await q.one("SELECT id,play_date,next_plan,training_projects FROM records WHERE member_id=? AND next_plan!='' ORDER BY play_date DESC,created_at DESC LIMIT 1",me.id);
      const monthlyRatings=await q.all('SELECT month,forehand,backhand,serve,return_skill,net,footwork,updated_at FROM monthly_ratings WHERE member_id=? ORDER BY month',me.id);
      return json({today,month,page,pageSize:20,summary:{...summary,training_sessions:Number(summary.training_sessions||0),checkin_days:dates.size,streak,checkedToday:dates.has(today)},checkins:monthCheckins,trainingDays,records,history,monthlyRatings,nextPlan});
    }
    if(url.pathname==='/api/pages-session'&&r.method==='POST'){
      if(r.headers.get('Origin')!==url.origin||r.headers.has('X-Tennis-Session')||!cookie(r))problem('请从原页面连接自己的名片。',403);
      const me=memberOnly(c);if(auth.account||me.account_id)problem('这张名片已经设置账号，请在 GitHub 页面用私密登录码登录。',403);
      return json({sessionToken:cookie(r)});
    }
    if(url.pathname==='/api/invite'&&r.method==='POST'){
      ownerOnly(c);const invite=secret();
      await q.batch([['INSERT INTO club_invites(invite_hash,club_id,created_at,expires_at) VALUES(?,?,?,?)',await digest(invite),c.club.id,new Date().toISOString(),Date.now()+7*86400000],auditStatement(c,'create-invite','additional')]);
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
        const saved=await q.one('SELECT id FROM members WHERE club_id=? AND account_id=? AND removed_at IS NULL',c.club.id,auth.account.id);return json({id:saved.id},201);
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
      const {bytes,type}=await uploadBytes(r);
      const key=`avatars/${c.club.id}/${me.id}/${crypto.randomUUID()}`;
      await env.BUCKET.put(key,bytes,{httpMetadata:{contentType:type}});
      try{const saved=await q.run('UPDATE members SET avatar_key=? WHERE id=? AND removed_at IS NULL',key,me.id);if(!saved.meta.changes)problem('成员权限已变化，请重新进入。',403);}catch(e){await env.BUCKET.delete(key);throw e;}
      if(me.avatar_key){try{await env.BUCKET.delete(me.avatar_key);}catch(e){console.error('Old avatar cleanup failed');}}
      return json({ok:true});
    }
    if(url.pathname.startsWith('/api/avatar/')&&r.method==='GET'){
      const m=await q.one('SELECT avatar_key FROM members WHERE id=? AND club_id=?',id(url.pathname.split('/').pop()),c.club.id);
      if(!m?.avatar_key)return new Response(null,{status:404});if(!env.BUCKET)problem('头像暂时无法加载。',503);
      return imageResponse(env,m.avatar_key);
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
      if(!record)problem('这场记录已经不在了。',404);if(record.member_id!==me.id&&r.method!=='DELETE')problem('只能修改自己的打球记录。',403);
      if(r.method==='DELETE'){
        if(record.member_id!==me.id)ownerOnly(c);
        const photos=await q.all('SELECT object_key FROM record_photos WHERE record_id=?',recordId),statements=[['DELETE FROM records WHERE id=? AND club_id=?',recordId,c.club.id]];
        if(record.member_id!==me.id)statements.push(auditStatement(c,'delete-record',recordId,{author:record.member_id}));
        await q.batch(statements);if(env.BUCKET)for(const photo of photos)await env.BUCKET.delete(photo.object_key);return json({ok:true});
      }
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
