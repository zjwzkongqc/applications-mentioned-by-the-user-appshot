// Explicit opt-in live integration test, not part of test/*.test.mjs.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {chromium} from 'playwright';
const pageBase='https://zjwzkongqc.github.io/applications-mentioned-by-the-user-appshot/fresh/';
const origin='https://kvbxmvwtblwibhesnleh.supabase.co';
const base=origin+'/functions/v1/tennis-fresh';
const report={passed:false,checks:[],fixtureAccounts:[],fixtureClubs:[],fixtureRecords:[],fixtureName:'__fresh_test_'+(process.env.GITHUB_RUN_ID||Date.now()),livePages:process.env.LIVE_PAGES==='1',mainlandTested:false};
let stage='initialization',browser;
async function step(name,condition){stage=name;assert(condition,name);report.checks.push(name);}
async function call(name,route,{method='GET',user,invite,data,bytes,status=200}={}){
 stage=name;
 const headers={Origin:'https://zjwzkongqc.github.io','x-region':'ap-southeast-1'};
 if(user)headers['X-Tennis-Session']=user.sessionToken;
 if(invite)headers.Authorization='Bearer '+invite;
 if(data!==undefined)headers['Content-Type']='application/json';
 if(bytes)headers['Content-Type']='image/png';
 const response=await fetch(base+route,{method,headers,body:bytes||(data!==undefined?JSON.stringify(data):undefined),signal:AbortSignal.timeout(45000),redirect:'error'});
 assert.equal(response.status,status,name+' HTTP status');report.checks.push(name);
 if(response.headers.get('Content-Type')?.includes('application/json'))return response.json();
 return new Uint8Array(await response.arrayBuffer());
}
const skill={forehand:0,backhand:null,serve:5,return_skill:5,net:5,footwork:5};
try{
 const health=await call('fresh-backend-ready','/healthz');
 await step('explicit-new-app-not-fake-migration',health.ready===true&&health.mode==='new-empty-app'&&health.legacyDataImported===false);
 const old=await fetch(origin+'/functions/v1/tennis-api/healthz',{signal:AbortSignal.timeout(45000)});
 await step('old-migration-receiver-still-closed',(await old.json()).maintenance===true);
 const users=[];
 for(let i=0;i<3;i++){
  const u=await call('create-test-account-'+i,'/api/auth/start',{method:'POST',data:{nickname:report.fixtureName.slice(0,15)+i,startNonce:crypto.randomBytes(32).toString('hex')},status:201});
  users.push(u);report.fixtureAccounts.push(u.account.id);
 }
 const [A,B,C]=users;
 const created=await call('create-test-group','/api/clubs',{method:'POST',user:A,data:{name:report.fixtureName.slice(0,24),slogan:'临时验收，随后清理',nickname:'验收A'},status:201});
 const mine=await call('read-owner-group','/api/auth/me',{user:A});
 const club=mine.clubs[0].id;report.fixtureClubs.push(club);const group='?club='+club;
 await call('join-second-account','/api/profile',{method:'POST',user:B,invite:created.invite,data:{nickname:'验收B',bio:'test'},status:201});
 const board=await call('read-private-group','/api/board'+group,{user:A});
 const memberA=board.me;
 await call('anonymous-denied','/api/board'+group,{status:401});
 await call('outsider-denied','/api/board'+group,{user:C,status:403});
 const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
 const record={id:crypto.randomUUID(),playDate:day,minutes:40,partners:'测试',venue:'测试球场',mood:'认真练球',note:report.fixtureName,skills:skill,training:{projects:['backhand'],content:'单反验收',effect:'practice',effectNote:'测试',nextPlan:'继续练习'}};
 report.fixtureRecords.push(record.id);
 await call('save-training','/api/records'+group,{method:'POST',user:A,data:record,status:201});
 await call('save-monthly-rating','/api/ratings'+group,{method:'POST',user:A,data:{month:day.slice(0,7),skills:skill}});
 await call('deny-other-record-edit','/api/records/'+record.id+group,{method:'PATCH',user:B,data:{...record,note:'tamper'},status:403});
 await call('deny-other-record-delete','/api/records/'+record.id+group,{method:'DELETE',user:B,status:403});
 await call('deny-other-rating-edit','/api/ratings'+group,{method:'POST',user:B,data:{memberId:memberA,month:day.slice(0,7),skills:skill},status:403});
 const recovered=await call('recover-independent-session','/api/auth/login',{method:'POST',data:{recoveryCode:A.recoveryCode}});
 await step('recovery-retains-identity',recovered.account.id===A.account.id&&recovered.sessionToken!==A.sessionToken);
 const restored=await call('recover-saved-record','/api/board'+group,{user:recovered});
 await step('record-persisted-zero-distinct-from-null',restored.records.find(r=>r.id===record.id)?.note===record.note&&restored.members.find(m=>m.id===memberA)?.rating.forehand===0&&restored.members.find(m=>m.id===memberA)?.rating.backhand===null);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZuoAAAAASUVORK5CYII=','base64');
 const photo=await call('upload-private-photo','/api/records/'+record.id+'/photos'+group,{method:'POST',user:A,bytes:png,status:201});
 const image=await call('read-group-photo','/api/photos/'+photo.id+group,{user:B});
 await step('photo-byte-equality',Buffer.compare(png,Buffer.from(image))===0);
 await call('deny-anonymous-photo','/api/photos/'+photo.id+group,{status:401});
 await call('delete-own-test-photo','/api/photos/'+photo.id+group,{method:'DELETE',user:A});
 browser=await chromium.launch({headless:true});
 async function context(user,viewport={width:390,height:844}){
  const ctx=await browser.newContext({viewport});
  if(!report.livePages)await ctx.route(pageBase+'**',async route=>{
   const requested=new URL(route.request().url()),rel=requested.pathname.slice(new URL(pageBase).pathname.length)||'index.html';
   if(!/^[a-zA-Z0-9_.-]+$/.test(rel))return route.abort();
   const ext=path.extname(rel),types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'};
   return route.fulfill({status:200,contentType:types[ext]||'text/plain',body:await fs.readFile(path.join('dist/pages/fresh',rel))});
  });
  if(user)await ctx.addInitScript(({key,token})=>localStorage.setItem(key,token),{key:'tennis-club:account:'+origin+':'+pageBase,token:user.sessionToken});
  return ctx;
 }
 const ctx=await context(A),page=await ctx.newPage();let errors=[];
 page.on('pageerror',e=>errors.push(e.name));
 const traffic=[];page.on('request',r=>traffic.push(r.url()));
 await page.goto(pageBase+'#c='+club,{waitUntil:'networkidle',timeout:60000});
 await page.locator('.shell').waitFor({timeout:45000});
 await step('mobile-browser-loaded-private-group',await page.locator('.identity-strip').innerText().then(t=>t.includes('验收A')));
 stage='browser-record-form';await page.evaluate(()=>openRecord());
 await page.locator('#minutes').fill('55');await page.locator('#record-note').fill('browser-'+report.fixtureName);
 await page.locator('#record-form button[type=submit]').click();
 await page.waitForFunction(()=>!document.querySelector('#modal').open,{timeout:45000});
 await page.reload({waitUntil:'networkidle'});await page.locator('.shell').waitFor({timeout:45000});
 await step('browser-record-survives-reload',(await page.locator('#app').innerText()).includes('browser-'+report.fixtureName));
 const refreshed=await call('read-browser-created-record','/api/board'+group,{user:A});
 const uiRecord=refreshed.records.find(r=>r.note==='browser-'+report.fixtureName);await step('browser-save-in-real-database',uiRecord?.minutes===55);report.fixtureRecords.push(uiRecord.id);
 stage='browser-monthly-form';await page.evaluate(()=>openMonthlyRatings());await page.locator('#rating-serve').selectOption('6');await page.locator('#monthly-rating-form button[type=submit]').click();await page.waitForFunction(()=>!document.querySelector('#modal').open,{timeout:45000});
 const rating=await call('read-browser-monthly-score','/api/ratings'+group,{user:A});await step('browser-monthly-score-persisted',rating.ratings[0].serve===6);
 const ctxB=await context(B),pB=await ctxB.newPage();await pB.goto(pageBase+'#c='+club,{waitUntil:'networkidle',timeout:60000});await pB.locator('.shell').waitFor({timeout:45000});await step('second-browser-has-own-identity',(await pB.locator('.identity-strip').innerText()).includes('验收B'));
 const ctxR=await context(null),pR=await ctxR.newPage();await pR.goto(pageBase,{waitUntil:'networkidle',timeout:60000});await pR.locator('#create-form').waitFor({timeout:45000});await pR.evaluate(()=>openRecoveryLogin());await pR.locator('#recovery-code').fill(A.recoveryCode);await pR.locator('#auth-form button[type=submit]').click();await pR.waitForFunction(()=>!document.querySelector('#modal').open,{timeout:45000});await pR.locator('[data-action="open-club"]').first().click();await pR.locator('.shell').waitFor({timeout:45000});await step('recovery-login-through-real-browser-form',(await pR.locator('.identity-strip').innerText()).includes('验收A'));
 await step('mobile-no-horizontal-overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await step('no-browser-runtime-errors',errors.length===0);
 await step('new-page-never-contacts-old-site',!traffic.some(u=>u.includes('chatgpt.site')||u.includes('/functions/v1/tennis-api')));
 const publicCtx=await context(null,{width:1440,height:1000}),publicPage=await publicCtx.newPage();await publicPage.goto(pageBase,{waitUntil:'networkidle',timeout:60000});await publicPage.locator('#create-form').waitFor({timeout:45000});await publicPage.screenshot({path:'fresh-welcome.png',fullPage:true});
 report.passed=true;
}catch(error){report.failedStage=stage;report.errorType=error.name;report.errorMessage=String(error.message).replace(/TC-[A-Z0-9-]+/g,'[redacted]').slice(0,200);}
finally{if(browser)await browser.close();await fs.writeFile('fresh-live-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
if(!report.passed)process.exitCode=1;
