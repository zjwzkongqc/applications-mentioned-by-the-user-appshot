// Isolated acceptance runner. No production routes, data or migration receipts.
// Version 1 passed the live scenario suite. This archived entry fixes only report
// serialization ($3::text::jsonb); the one completed v1 report was normalized.
import postgres from 'npm:postgres@3.4.7';
import worker from 'https://raw.githubusercontent.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/ffbdc4b892be0da9d0674e77b00f524b5dfcd18b/src/worker.js';
import {createPostgresDatabase,postgresOptions} from 'https://raw.githubusercontent.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/ffbdc4b892be0da9d0674e77b00f524b5dfcd18b/supabase/functions/tennis-api/postgres.mjs';
import {createSupabaseBucket} from 'https://raw.githubusercontent.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/ffbdc4b892be0da9d0674e77b00f524b5dfcd18b/supabase/functions/tennis-api/storage.mjs';
import {runScenarios} from 'https://raw.githubusercontent.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/b30a0930cdb5479f49e692e711e71e56a7f0141a/deploy/supabase-acceptance/scenarios.mjs';
const origin='https://kvbxmvwtblwibhesnleh.supabase.co';
const repo='zjwzkongqc/applications-mentioned-by-the-user-appshot';
const ref='refs/heads/codex/supabase-free-preflight-20261004';
const audience='tennis-acceptance:kvbxmvwtblwibhesnleh';
const issuer='https://token.actions.githubusercontent.com';
const deadline=Date.parse('2026-10-05T00:00:00Z');
const encode=new TextEncoder();
function bytes(s){if(typeof s!=='string'||!/^[A-Za-z0-9_-]+$/.test(s))throw new Error('Invalid token');return Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));}
async function authorize(request){
 const token=request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];
 if(!token||token.length>16000)throw new Error('Denied');
 const parts=token.split('.');if(parts.length!==3)throw new Error('Denied');
 const header=JSON.parse(new TextDecoder().decode(bytes(parts[0]))),c=JSON.parse(new TextDecoder().decode(bytes(parts[1]))),now=Date.now()/1000;
 if(header.alg!=='RS256'||typeof header.kid!=='string'||header.typ!=='JWT'||c.iss!==issuer||c.aud!==audience||c.repository!==repo||c.repository_id!=='1268831911'||c.repository_owner_id!=='221818491'||c.ref!==ref||c.workflow_ref!==repo+'/.github/workflows/acceptance-supabase.yml@'+ref||!['push','workflow_dispatch'].includes(c.event_name)||!/^\d+$/.test(c.run_id)||!/^\d+$/.test(c.run_attempt)||![c.iat,c.nbf,c.exp].every(Number.isFinite)||c.exp<=now||c.nbf>now+30||c.iat>now+30||c.iat<now-600||c.exp-c.iat>600)throw new Error('Denied');
 const subjects=['repo:'+repo+':ref:'+ref,'repo:zjwzkongqc@221818491/applications-mentioned-by-the-user-appshot@1268831911:ref:'+ref];if(!subjects.includes(c.sub))throw new Error('Denied');
 const response=await fetch(issuer+'/.well-known/jwks',{redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('Denied');
 const jwks=await response.json(),jwk=jwks.keys?.find(k=>k.kid===header.kid&&k.kty==='RSA');if(!jwk)throw new Error('Denied');
 const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
 if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,bytes(parts[2]),encode.encode(parts[0]+'.'+parts[1])))throw new Error('Denied');return c;
}
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
Deno.serve(async request=>{
 const path=new URL(request.url).pathname;
 if(request.method!=='POST'||!['/tennis-acceptance/run','/functions/v1/tennis-acceptance/run'].includes(path)||Date.now()>deadline)return json({error:'Not available'},404);
 let claims;try{claims=await authorize(request);}catch{return json({error:'Not authorized'},401);}
 if(request.body){const body=await request.arrayBuffer();if(body.byteLength)return json({error:'No input accepted'},400);}
 if(Deno.env.get('SUPABASE_URL')!==origin)return json({error:'Project mismatch'},503);
 let sql;
 try{
  const ca=Deno.env.get('TENNIS_DB_CA_PEM');
  sql=postgres(Deno.env.get('SUPABASE_DB_URL'),{...postgresOptions(),ssl:{rejectUnauthorized:true,...(ca?{ca}: {})}});
  const within=(options,fn)=>sql.begin(options,async tx=>{await tx.unsafe('SET LOCAL ROLE tennis_acceptance_runner');await tx.unsafe('SET LOCAL search_path=tennis_acceptance,pg_catalog');return fn(tx);});
  const connection={unsafe:(q,p=[])=>within('isolation level serializable',tx=>tx.unsafe(q,p)),begin:(options,fn)=>within(options,fn)};
  const runId=claims.run_id+':'+claims.run_attempt;
  const inserted=await connection.unsafe("INSERT INTO runs(id,status) SELECT $1,'running' WHERE (SELECT count(*) FROM runs)<4 AND NOT EXISTS(SELECT 1 FROM runs WHERE status='running') ON CONFLICT DO NOTHING RETURNING id",[runId]);
  if(!inserted.length){const previous=await connection.unsafe('SELECT status,report FROM runs WHERE id=$1',[runId]);const report=previous[0]?.report;return report?json(typeof report==='string'?JSON.parse(report):report,previous[0].status==='passed'?200:422):json({error:'Acceptance run is already active or the test budget is exhausted'},409);}
  const DB=createPostgresDatabase(connection),rawBucket='tennis-acceptance-avatars';
  const BUCKET=createSupabaseBucket({url:origin,serviceRoleKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),bucket:rawBucket});
  const report=await runScenarios({worker,DB,BUCKET,connection,origin,rawBucket});
  await connection.unsafe('UPDATE runs SET status=$2,finished_at=now(),report=$3::text::jsonb WHERE id=$1',[runId,report.passed?'passed':'failed',JSON.stringify(report)]);
  return json(report,report.passed?200:422);
 }catch{return json({error:'Isolated acceptance execution was not confirmed'},503);}finally{if(sql)await sql.end({timeout:5});}
});
