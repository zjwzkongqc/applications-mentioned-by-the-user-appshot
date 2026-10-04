import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
const base='https://zjwzkongqc.github.io/applications-mentioned-by-the-user-appshot/fresh/';
const browser=await chromium.launch({headless:true});
const ctx=await browser.newContext({viewport:{width:390,height:844}});
const report={requests:[],responses:[],console:[],errors:[]};
await ctx.route(base+'**',async route=>{const u=new URL(route.request().url()),rel=u.pathname.slice(new URL(base).pathname.length)||'index.html';if(!/^[a-zA-Z0-9_.-]+$/.test(rel))return route.abort();const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'};await route.fulfill({status:200,contentType:types[path.extname(rel)]||'text/plain',body:await fs.readFile(path.join('dist/pages/fresh',rel))});});
const page=await ctx.newPage();
page.on('request',r=>report.requests.push({path:new URL(r.url()).pathname,type:r.resourceType()}));
page.on('response',r=>report.responses.push({path:new URL(r.url()).pathname,status:r.status(),type:r.headers()['content-type']}));
page.on('console',m=>{if(report.console.length<20)report.console.push({type:m.type(),text:m.text().slice(0,500)});});
page.on('pageerror',e=>report.errors.push({name:e.name,message:e.message}));
try{await page.goto(base,{waitUntil:'domcontentloaded',timeout:20000});await page.locator('#create-form').waitFor({timeout:15000});}catch(e){report.failure=e.message.slice(0,300);}
report.page=await page.evaluate(()=>({title:document.title,ready:document.readyState,contentType:document.contentType,appText:document.querySelector('#app')?.innerText,scripts:[...document.scripts].map(s=>({src:s.src,defer:s.defer})),config:window.TENNIS_CONFIG,initialized:typeof state!=='undefined'?{authReady:state.authReady,authError:state.authError,hasAccount:!!state.account}:null}));
await page.screenshot({path:'fresh-diagnostic.png',fullPage:true});
await browser.close();
await fs.writeFile('fresh-diagnostic.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
