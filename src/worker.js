/*__ASSETS__*/
const encoder = new TextEncoder();
const MAX_BODY = 20000;
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
function secret(){return [...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('');}
function cookie(r){return r.headers.get('Cookie')?.match(/(?:^|;\s*)tc_session=([a-f0-9]{64})(?:;|$)/)?.[1] || null;}
function cookieHeader(token,url){return {'Set-Cookie':`tc_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${url.protocol==='https:'?'; Secure':''}`};}
async function body(r){if(Number(r.headers.get('Content-Length'))>MAX_BODY)problem('填写的内容太长了。',413);if(!r.headers.get('Content-Type')?.includes('application/json'))problem('请使用页面中的表单提交。',415);let raw=await r.text();if(raw.length>MAX_BODY)problem('填写的内容太长了。',413);try{return JSON.parse(raw);}catch{problem('内容格式不正确，请重试。');}}
function str(v,max,required=false){if(typeof v!=='string')problem('请填写有效的文字。');v=v.trim();if(v.length>max || (required&&!v))problem(required?`请填写内容，最多 ${max} 个字。`:`内容最多 ${max} 个字。`);return v;}
function id(v){if(typeof v!=='string'||! /^[a-f0-9-]{36}$/.test(v))problem('记录编号无效。');return v;}
function recordInput(b){const date=str(b.playDate,10,true),parsed=new Date(`${date}T00:00:00Z`);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==date)problem('请选择有效的打球日期。');const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);if(date>tomorrow)problem('还没发生的场次，等打完再记。');const minutes=Number(b.minutes);if(!Number.isInteger(minutes)||minutes<1||minutes>1440)problem('时长请填 1–1440 分钟。');if(!MOODS.includes(b.mood))problem('请选择今天的状态。');return {date,minutes,partners:str(b.partners||'',120),venue:str(b.venue||'',60),mood:b.mood,note:str(b.note||'',500)};}
function db(env){if(!env.DB)problem('小本本暂时连不上，请稍后再试。',503);return {one:(sql,...args)=>env.DB.prepare(sql).bind(...args).first(),all:async(sql,...args)=>(await env.DB.prepare(sql).bind(...args).all()).results,run:(sql,...args)=>env.DB.prepare(sql).bind(...args).run(),batch:(statements)=>env.DB.batch(statements.map(([sql,...args])=>env.DB.prepare(sql).bind(...args)))};}
async function context(r,q){const invite=r.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];if(!invite)problem('请从群里的邀请链接进入。',401);const club=await q.one('SELECT * FROM clubs WHERE invite_hash = ?',await digest(invite));if(!club)problem('邀请链接无效，请向群友要一个新链接。',404);const token=cookie(r);const me=token?await q.one('SELECT * FROM members WHERE club_id = ? AND session_hash = ?',club.id,await digest(token)):null;return {club,me};}
function memberOnly(c){if(!c.me)problem('先取个昵称，加入球友名片吧。',401);return c.me;}
export default {
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
      const origin=r.headers.get('Origin');if(origin&&origin!==url.origin)problem('请在原页面完成操作。',403);
      if(r.headers.get('Sec-Fetch-Site')==='cross-site')problem('请在原页面完成操作。',403);
    }
    const q=db(env);
    if(url.pathname==='/api/clubs'&&r.method==='POST'){
      const b=await body(r), name=str(b.name,24,true), slogan=str(b.slogan||'',80), nickname=str(b.nickname,20,true);
      const token=cookie(r)||secret(), sessionHash=await digest(token);
      if(Number((await q.one('SELECT COUNT(*) AS n FROM members WHERE session_hash = ?',sessionHash)).n)>=5)problem('你已经有 5 本群小本本了，先用现有的吧。');
      const invite=secret(),clubId=crypto.randomUUID(),memberId=crypto.randomUUID(),now=new Date().toISOString();
      await q.batch([
        ['INSERT INTO clubs(id,invite_hash,name,slogan,owner_id,created_at) VALUES(?,?,?,?,?,?)',clubId,await digest(invite),name,slogan,memberId,now],
        ['INSERT INTO members(id,club_id,session_hash,nickname,bio,created_at) VALUES(?,?,?,?,?,?)',memberId,clubId,sessionHash,nickname,'',now]
      ]);
      return json({invite},201,cookieHeader(token,url));
    }
    const c=await context(r,q);
    if(url.pathname==='/api/board'&&r.method==='GET'){
      const members=await q.all('SELECT m.id,m.nickname,m.bio,m.avatar_key,m.created_at,COUNT(r.id) AS record_count,COALESCE(SUM(r.minutes),0) AS minutes,COUNT(r.forehand) AS rated_count,AVG(r.forehand) AS avg_forehand,AVG(r.backhand) AS avg_backhand,AVG(r.serve) AS avg_serve,AVG(r.return_skill) AS avg_return_skill,AVG(r.net) AS avg_net,AVG(r.footwork) AS avg_footwork FROM members m LEFT JOIN records r ON r.member_id=m.id WHERE m.club_id=? GROUP BY m.id ORDER BY m.created_at',c.club.id);
      const records=await q.all('SELECT r.*,m.nickname FROM records r JOIN members m ON m.id=r.member_id WHERE r.club_id=? ORDER BY r.play_date DESC,r.created_at DESC LIMIT 500',c.club.id);
      const cheers=await q.all('SELECT h.record_id,h.member_id,h.emoji FROM cheers h JOIN records r ON r.id=h.record_id WHERE r.club_id=?',c.club.id);
      const culture=await q.all('SELECT p.*,m.nickname FROM culture p JOIN members m ON m.id=p.member_id WHERE p.club_id=? ORDER BY p.created_at DESC LIMIT 200',c.club.id);
      const totals=await q.one('SELECT COUNT(*) AS records,COALESCE(SUM(minutes),0) AS minutes FROM records WHERE club_id=?',c.club.id);
      const todayCheckins=await q.all('SELECT member_id FROM checkins WHERE club_id=? AND checkin_date=?',c.club.id,chinaDay());
      return json({club:{id:c.club.id,name:c.club.name,slogan:c.club.slogan,ownerId:c.club.owner_id},me:c.me?.id||null,members:members.map(m=>({...m,hasAvatar:!!m.avatar_key,avatarVersion:m.avatar_key,avatar_key:undefined})),records,cheers,culture,totals,today:chinaDay(),todayCheckins:todayCheckins.map(x=>x.member_id)});
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
    if(url.pathname==='/api/profile'&&r.method==='POST'){
      const b=await body(r),nickname=str(b.nickname,20,true),bio=str(b.bio||'',80);
      if(c.me){await q.run('UPDATE members SET nickname=?,bio=? WHERE id=? AND club_id=?',nickname,bio,c.me.id,c.club.id);return json({id:c.me.id});}
      const token=cookie(r)||secret(), sessionHash=await digest(token),memberId=crypto.randomUUID();
      await q.run('INSERT INTO members(id,club_id,session_hash,nickname,bio,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(club_id,session_hash) DO UPDATE SET nickname=excluded.nickname,bio=excluded.bio',memberId,c.club.id,sessionHash,nickname,bio,new Date().toISOString());
      const saved=await q.one('SELECT id FROM members WHERE club_id=? AND session_hash=?',c.club.id,sessionHash);
      return json({id:saved.id},201,cookieHeader(token,url));
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
