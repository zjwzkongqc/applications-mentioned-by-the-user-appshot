import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {buildPages} from './build-pages.mjs';
import {ACTIVE_NOTEBOOK,FRESH_FEATURES} from '../deploy/fresh/settings.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
export const FRESH_PAGE='https://zjwzkongqc.github.io/applications-mentioned-by-the-user-appshot/fresh/';
export const FRESH_ORIGIN='https://kvbxmvwtblwibhesnleh.supabase.co';
export const FRESH_PREFIX='/functions/v1/tennis-fresh';
export async function buildFreshPages(){
 const output=path.join(root,'dist/pages/fresh');
 await buildPages({output,env:{TENNIS_API_BASE_URL:FRESH_ORIGIN,TENNIS_API_PATH_PREFIX:'/functions/v1/tennis-api'}});
 const config={apiBaseUrl:FRESH_ORIGIN,apiPathPrefix:FRESH_PREFIX,pageBaseUrl:FRESH_PAGE,sameOriginOnly:true,freshStart:true,functionRegion:'ap-southeast-1',singleNotebook:ACTIVE_NOTEBOOK};
 await fs.writeFile(path.join(output,'config.js'),'window.TENNIS_CONFIG=Object.freeze('+JSON.stringify(config)+');\n');
 let app=await fs.readFile(path.join(output,'app.js'),'utf8');
 function replaceOnce(source,replacement){assert.equal(app.split(source).length,2,'Review the fresh frontend adaptation: '+source);app=app.replace(source,replacement);}
 replaceOnce("if(!['','/functions/v1/tennis-api'].includes(apiPathPrefix))","if(apiPathPrefix!=='/functions/v1/tennis-fresh')");
 // The shared API performs multiple SQL round trips. Invoke it beside the
 // Singapore database rather than paying a cross-continent hop for each query.
 // The documented query parameter also routes browser CORS preflight correctly.
 // https://supabase.com/docs/guides/functions/regional-invocation
 replaceOnce('url.pathname=apiPathPrefix+url.pathname;return url;',"url.pathname=apiPathPrefix+url.pathname;url.searchParams.set('forceFunctionRegion','ap-southeast-1');return url;");
 replaceOnce("return fetch(url,{...fetchOptions,headers,credentials:remoteApi?'omit':'same-origin',redirect:'error'});","const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);try{return await fetch(url,{...fetchOptions,signal:fetchOptions.signal||controller.signal,headers,credentials:remoteApi?'omit':'same-origin',redirect:'error'});}finally{clearTimeout(timer);}");
 // Never copy credentials from the original website namespace.
 assert(!Object.hasOwn(config,'credentialMigration'));
 await fs.writeFile(path.join(output,'app.js'),app);
 let css=await fs.readFile(path.join(output,'style.css'),'utf8');
 css+='\n.fresh-site-note{position:relative;z-index:5;padding:10px 20px;text-align:center;background:#eaf2df;color:#25402d;font:500 12px/1.65 system-ui,sans-serif;border-bottom:1px solid #d5dfcc}.fresh-site-note strong{font-weight:750}.fresh-site-note span{display:inline-block;margin:0 6px}@media(max-width:600px){.fresh-site-note{padding:9px 14px;font-size:11px;text-align:left}}\n';
 await fs.writeFile(path.join(output,'style.css'),css);
 for(const file of ['notebook.js','notebook.css','wishes.js','wishes.css'])await fs.copyFile(path.join(root,'src',file),path.join(output,file));
 let html=await fs.readFile(path.join(output,'index.html'),'utf8');
 html=html.replace('</head>','  <link rel="stylesheet" href="./notebook.css">\n  <script src="./notebook.js" defer></script>\n  <link rel="stylesheet" href="./wishes.css">\n  <script src="./wishes.js" defer></script>\n</head>');
 html=html.replace('<body>','<body>\n  <div class="fresh-site-note" role="note"><strong>我们的网球记录本</strong><span>每一场球，都算数。</span><span>每人独立名片，恢复码只自己保存</span></div>');
 for(const file of ['config.js','style.css','app.js','hexagon.js','growth.js','club-ui.js','notebook.js','notebook.css','wishes.js','wishes.css']){
  const version=createHash('sha256').update(await fs.readFile(path.join(output,file))).digest('hex').slice(0,12);
  html=html.replace(new RegExp('(\\./'+file.replace('.','\\.')+')(?:\\?v=[a-f0-9]+)?','g'),'$1?v='+version);
 }
 await fs.writeFile(path.join(output,'index.html'),html);
 await fs.writeFile(path.join(output,'release.json'),JSON.stringify({release:'fresh-v1',features:FRESH_FEATURES,page:FRESH_PAGE,api:FRESH_ORIGIN+FRESH_PREFIX,mode:'new-empty-app',legacyDataImported:false,functionRegion:'ap-southeast-1'}));
 const demos=path.join(output,'themes');
 await fs.mkdir(demos,{recursive:true});
 let demoHtml=await fs.readFile(path.join(root,'src/theme-demos/index.html'),'utf8');
 for(const file of ['themes.css','themes.js']){
  const content=await fs.readFile(path.join(root,'src/theme-demos',file));
  await fs.writeFile(path.join(demos,file),content);
  demoHtml=demoHtml.replace('./'+file,'./'+file+'?v='+createHash('sha256').update(content).digest('hex').slice(0,12));
 }
 await fs.writeFile(path.join(demos,'index.html'),demoHtml);
 console.log('Built independent fresh app at '+FRESH_PAGE);
 return output;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildFreshPages();
