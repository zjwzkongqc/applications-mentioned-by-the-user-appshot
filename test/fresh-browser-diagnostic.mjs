import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {chromium} from 'playwright';
const base='https://zjwzkongqc.github.io/applications-mentioned-by-the-user-appshot/fresh/';
const origin='https://kvbxmvwtblwibhesnleh.supabase.co',api=origin+'/functions/v1/tennis-fresh';
const report={requests:[],responses:[],console:[],errors:[],fixtureAccounts:[],fixtureClubs:[]};
async function call(route,data,user){const r=await fetch(api+route,{method:data?'POST':'GET',headers:{Origin:'https://zjwzkongqc.github.io','Content-Type':'application/json',...(user?{'X-Tennis-Session':user.sessionToken}:{})},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error('Test API HTTP '+r.status);return r.json();}
const preflight=await fetch(api+'/api/auth/me',{method:'OPTIONS',headers:{Origin:'https://zjwzkongqc.github.io','Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'x-tennis-session'},signal:AbortSignal.timeout(30000)});report.preflight={status:preflight.status,headers:Object.fromEntries([...preflight.headers].filter(([k])=>k.startsWith('access-control')))};await preflight.body?.cancel();
const user=await call('/api/auth/start',{nickname:'诊断测试'+String(process.env.GITHUB_RUN_ID).slice(-6),startNonce:crypto.randomBytes(32).toString('hex')});report.fixtureAccounts.push(user.account.id);
await call('/api/clubs',{name:'__diagnostic_'+String(process.env.GITHUB_RUN_ID).slice(-6),nickname:'诊断测试',slogan:'临时测试'},user);const mine=await call('/api/auth/me',null,user);const club=mine.clubs[0].id;report.fixtureClubs.push(club);
const browser=await chromium.launch({headless:true});
const ctx=await browser.newContext({viewport:{width:390,height:844}});
await ctx.route(base+'**',async route=>{const u=new URL(route.request().url()),rel=u.pathname.slice(new URL(base).pathname.length)||'index.html';if(!/^[a-zA-Z0-9_.-]+$/.test(rel))return route.abort();const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'};await route.fulfill({status:200,contentType:types[path.extname(rel)]||'text/plain',body:await fs.readFile(path.join('dist/pages/fresh',rel))});});
await ctx.addInitScript(({key,token})=>localStorage.setItem(key,token),{key:'tennis-club:account:'+origin+':'+base,token:user.sessionToken});
const page=await ctx.newPage();
page.on('request',r=>report.requests.push({path:new URL(r.url()).pathname,type:r.resourceType(),method:r.method()}));
page.on('response',r=>report.responses.push({path:new URL(r.url()).pathname,status:r.status(),type:r.headers()['content-type']}));
page.on('requestfailed',r=>report.errors.push({path:new URL(r.url()).pathname,error:r.failure()?.errorText}));
page.on('console',m=>{if(report.console.length<20)report.console.push({type:m.type(),text:m.text().replace(/TC-[A-Z0-9-]+/g,'[redacted]').slice(0,500)});});
page.on('pageerror',e=>report.errors.push({name:e.name,message:e.message}));
try{await page.goto(base+'#c='+club,{waitUntil:'domcontentloaded',timeout:20000});await page.locator('.shell').waitFor({timeout:20000});}catch(e){report.failure=e.message.slice(0,300);}
report.page=await page.evaluate(()=>({title:document.title,ready:document.readyState,contentType:document.contentType,appText:document.querySelector('#app')?.innerText,config:window.TENNIS_CONFIG,initialized:typeof state!=='undefined'?{authReady:state.authReady,authError:state.authError,hasAccount:!!state.account,hasSession:!!state.accountSession,club:state.club,hasBoard:!!state.board,error:state.error,epoch:state.epoch,hasGrowth:!!Growth.model.data,growthError:Growth.model.error}:null}));
await page.screenshot({path:'fresh-diagnostic.png',fullPage:true});await browser.close();
await fs.writeFile('fresh-diagnostic.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
