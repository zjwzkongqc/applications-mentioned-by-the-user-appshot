import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
const pageBase='https://zjwzkongqc.github.io/applications-mentioned-by-the-user-appshot/fresh/';
const origin='https://kvbxmvwtblwibhesnleh.supabase.co';
const api=origin+'/functions/v1/tennis-fresh';
const report={passed:false,readOnly:true,mainlandTested:false,checks:[]};
let browser;
const check=(label,value)=>{assert(value,label);report.checks.push(label);};
async function json(url){const r=await fetch(url,{headers:{Origin:'https://zjwzkongqc.github.io'},redirect:'error',signal:AbortSignal.timeout(30000)});assert.equal(r.status,200,'GET '+new URL(url).pathname);return r.json();}
try{
 const release=await json(pageBase+'release.json');check('published-fresh-release',release.release==='fresh-v1'&&release.mode==='new-empty-app'&&release.legacyDataImported===false);
 const health=await json(api+'/healthz?forceFunctionRegion=ap-southeast-1');check('fresh-api-ready',health.ready===true&&health.mode==='new-empty-app');
 check('personal-wishes-deployed',release.features?.includes('training-wishes-v1')&&health.features?.includes('training-wishes-v1'));
 check('single-notebook-deployed',release.features?.includes('single-notebook-v1')&&health.features?.includes('single-notebook-v1'));
 const wishes=await fetch(api+'/api/wishes?forceFunctionRegion=ap-southeast-1',{headers:{Origin:'https://zjwzkongqc.github.io'},redirect:'error',signal:AbortSignal.timeout(30000)});
 check('personal-wishes-require-login',wishes.status===401&&wishes.headers.get('Cache-Control')==='no-store');
 const identity=await json(api+'/api/auth/me?forceFunctionRegion=ap-southeast-1');check('anonymous-has-no-private-identity',identity.account===null&&identity.clubs.length===0);
 browser=await chromium.launch({headless:true});
 const ctx=await browser.newContext({viewport:{width:390,height:844}}),page=await ctx.newPage(),errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.name));page.on('request',r=>requests.push(r.url()));
 await page.goto(pageBase,{waitUntil:'domcontentloaded',timeout:45000});await page.locator('.notebook-access').waitFor({timeout:45000});
 check('actual-mobile-page-loaded',(await page.locator('.fresh-site-note').innerText()).includes('网球记录本'));
 check('notebook-creation-module-removed',await page.locator('#create-form').count()===0);
 check('frontend-points-to-new-app',await page.evaluate(()=>window.TENNIS_CONFIG.apiPathPrefix==='/functions/v1/tennis-fresh'&&window.TENNIS_CONFIG.freshStart===true&&!window.TENNIS_CONFIG.credentialMigration));
 check('personal-wishes-script-loaded',await page.evaluate(()=>typeof window.TennisWishes?.refresh==='function'));
 check('requests-use-database-region',requests.some(u=>u.includes('/tennis-fresh/')&&u.includes('forceFunctionRegion=ap-southeast-1')));
 check('no-old-site-requests',!requests.some(u=>u.includes('chatgpt.site')||u.includes('/functions/v1/tennis-api')));
 check('mobile-layout-fits',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 check('no-browser-script-errors',errors.length===0);
 await page.screenshot({path:'fresh-mobile-welcome.png',fullPage:true});
 await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'fresh-welcome.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await page.goto(pageBase+'themes/#gold',{waitUntil:'domcontentloaded',timeout:45000});
 await page.locator('[data-theme-option="gold"]').waitFor();
 check('five-theme-demos-published',await page.locator('[data-theme-option]').count()===5);
 check('direct-theme-link-works',await page.evaluate(()=>document.documentElement.dataset.theme==='gold'));
 for(const theme of ['forest','gold','clay','navy','sage']){
  await page.locator(`[data-theme-option="${theme}"]`).click();
  check('theme-'+theme,await page.evaluate(theme=>document.documentElement.dataset.theme===theme,theme));
  check('theme-mobile-layout-'+theme,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 }
 check('theme-demo-has-no-backend-session',await page.evaluate(()=>!window.TENNIS_CONFIG));
 check('no-demo-script-errors',errors.length===0);
 report.passed=true;
}catch(e){report.error=e.message.slice(0,300);}finally{if(browser)await browser.close();await fs.writeFile('fresh-smoke-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
if(!report.passed)process.exitCode=1;
