// A new, independent application authorized by the owner. No legacy migration,
// no fake receipt, no original data access, and no frontend/platform secrets.
import postgres from 'npm:postgres@3.4.7';
import worker from 'https://raw.githubusercontent.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/ffbdc4b892be0da9d0674e77b00f524b5dfcd18b/src/worker.js';
import {createPostgresDatabase,postgresOptions} from 'https://raw.githubusercontent.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/ffbdc4b892be0da9d0674e77b00f524b5dfcd18b/supabase/functions/tennis-api/postgres.mjs';
import {createSupabaseBucket} from 'https://raw.githubusercontent.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/ffbdc4b892be0da9d0674e77b00f524b5dfcd18b/supabase/functions/tennis-api/storage.mjs';
const ORIGIN='https://kvbxmvwtblwibhesnleh.supabase.co';
const PAGES='https://zjwzkongqc.github.io';
const PAGE='https://zjwzkongqc.github.io/applications-mentioned-by-the-user-appshot/fresh/';
const PREFIX='/functions/v1/tennis-fresh';
const RELEASE='fresh-v1';
if(Deno.env.get('SUPABASE_URL')!==ORIGIN)throw new Error('Project mismatch.');
const ca=Deno.env.get('TENNIS_DB_CA_PEM');
if(ca&&(!ca.includes('-----BEGIN CERTIFICATE-----')||ca.length>20000))throw new Error('Invalid database CA.');
const sql=postgres(Deno.env.get('SUPABASE_DB_URL'),{...postgresOptions(),ssl:{rejectUnauthorized:true,...(ca?{ca}:{})}});
const within=(options,fn)=>sql.begin(options,async tx=>{
 await tx.unsafe('SET LOCAL ROLE tennis_fresh_runner');
 await tx.unsafe('SET LOCAL search_path=tennis_fresh,pg_catalog');
 return fn(tx);
});
const connection={unsafe:(q,p=[])=>within('isolation level serializable',tx=>tx.unsafe(q,p)),begin:(options,fn)=>within(options,fn)};
const DB=createPostgresDatabase(connection);
const BUCKET=createSupabaseBucket({url:ORIGIN,serviceRoleKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),bucket:'tennis-fresh-media'});
function json(request,data,status=200){const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Vary':'Origin','X-Tennis-Release':RELEASE};if(request.headers.get('Origin')===PAGES)headers['Access-Control-Allow-Origin']=PAGES;return new Response(JSON.stringify(data),{status,headers});}
function route(path){for(const prefix of [PREFIX,'/tennis-fresh'])if(path===prefix||path.startsWith(prefix+'/'))return path.slice(prefix.length)||'/';return null;}
async function body(request,limit){if(!request.body)return undefined;const length=request.headers.get('Content-Length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit))throw Object.assign(new Error('Large request'),{status:413});const reader=request.body.getReader(),chunks=[];let size=0;try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw Object.assign(new Error('Large request'),{status:413});}chunks.push(value);}}finally{reader.releaseLock();}const result=new Uint8Array(size);let i=0;for(const chunk of chunks){result.set(chunk,i);i+=chunk.length;}return result;}
Deno.serve(async request=>{
 try{
  const url=new URL(request.url),path=route(url.pathname);
  if(path===null)return json(request,{error:'页面不存在。'},404);
  if(path==='/'&&request.method==='GET')return new Response(null,{status:302,headers:{Location:PAGE,'Cache-Control':'no-store'}});
  if(path.startsWith('/api/_owner/')||path.startsWith('/api/migration')||path==='/api/pages-session')return json(request,{error:'新站不提供旧站迁移或身份桥接。'},404);
  if(path!=='/healthz'&&!path.startsWith('/api/'))return json(request,{error:'页面不存在。'},404);
  const supplied=request.headers.get('Origin');
  if(supplied&&supplied!==PAGES)return json(request,{error:'请从新站页面操作。'},403);
  if(request.headers.get('Sec-Fetch-Site')==='cross-site'&&supplied!==PAGES)return json(request,{error:'请从新站页面操作。'},403);
  if(path==='/healthz'){
   if(!['GET','HEAD'].includes(request.method))return json(request,{error:'请求方式无效。'},405);
   const state=await connection.unsafe("SELECT mode,enabled FROM app_state WHERE id='fresh-v1'");
   const ready=state[0]?.mode==='new-empty-app'&&state[0]?.enabled===true;
   return json(request,{ok:ready,ready,mode:'new-empty-app',release:RELEASE,legacyDataImported:false},ready?200:503);
  }
  const state=await connection.unsafe("SELECT enabled FROM app_state WHERE id='fresh-v1' AND mode='new-empty-app'");
  if(state[0]?.enabled!==true)return json(request,{ready:false,error:'新站暂未开放。'},503);
  const encoding=request.headers.get('Content-Encoding');if(encoding&&encoding!=='identity')return json(request,{error:'请提交原始内容。'},415);
  const image=request.method==='POST'&&(path==='/api/avatar'||/^\/api\/records\/[a-f0-9-]{36}\/photos$/.test(path));
  const hasBody=!['GET','HEAD','OPTIONS'].includes(request.method);
  const bytes=hasBody?await body(request,image?2097152:20000):undefined;
  const headers=new Headers(request.headers);
  for(const name of ['cookie','host','connection','forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto','cf-connecting-ip','content-length'])headers.delete(name);
  // Explicit header sessions avoid sharing a cookie scope with the old receiver.
  // Treat all unverified network addresses as one conservative auth budget.
  headers.set('CF-Connecting-IP','tennis-fresh-shared');
  if(bytes)headers.set('Content-Length',String(bytes.byteLength));
  const response=await worker.fetch(new Request(ORIGIN+path+url.search,{method:request.method,headers,body:bytes}),{DB,BUCKET});
  const out=new Headers(response.headers);out.delete('Set-Cookie');out.set('Cache-Control','no-store');out.set('X-Content-Type-Options','nosniff');out.set('Referrer-Policy','no-referrer');out.set('X-Tennis-Release',RELEASE);
  return new Response(response.body,{status:response.status,headers:out});
 }catch(error){return json(request,{error:error?.status===413?'图片请小于 2MB，文字请缩短后重试。':'新站暂时连不上，请稍后重试。'},error?.status===413?413:503);}
});
