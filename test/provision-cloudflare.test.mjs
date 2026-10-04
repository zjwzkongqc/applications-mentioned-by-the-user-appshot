import test from 'node:test';
import assert from 'node:assert/strict';
import {provision} from '../scripts/provision-cloudflare.mjs';
const id='12345678-1234-1234-1234-123456789012';
const env={CF_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'test-secret'};
const reply=(result,status=200)=>({ok:status<400,status,json:async()=>({success:status<400,result,errors:[]})});

test('unconfigured push checks source without making external calls',async()=>{
  let called=false;
  assert.deepEqual(await provision({CF_DEPLOY_EVENT:'push'},async()=>{called=true;}),{configured:false});
  assert.equal(called,false);
  await assert.rejects(provision({CF_DEPLOY_EVENT:'workflow_dispatch'}),/CF_ACCOUNT_ID/);
});
test('reuse existing database and bucket without creating resources',async()=>{
  const calls=[];
  const result=await provision(env,async(url,options)=>{calls.push(options.method+' '+url);return url.includes('/d1/database?')?reply([{uuid:id,name:'tennis-club'}]):reply({name:'tennis-club'});});
  assert.deepEqual(result,{configured:true,databaseId:id,databaseName:'tennis-club',bucketName:'tennis-club'});
  assert.equal(calls.length,2);assert(calls.every(c=>c.startsWith('GET ')));
});
test('first deployment creates only missing D1 and R2 resources',async()=>{
  const calls=[];
  const result=await provision(env,async(url,options)=>{
    calls.push({url,method:options.method,body:options.body});
    if(url.includes('/d1/database?'))return reply([]);
    if(url.endsWith('/d1/database'))return reply({uuid:id,name:'tennis-club'});
    if(url.endsWith('/r2/buckets/tennis-club'))return reply(null,404);
    return reply({name:'tennis-club'});
  });
  assert.equal(result.databaseId,id);
  assert.deepEqual(calls.filter(c=>c.method==='POST').map(c=>JSON.parse(c.body)),[{name:'tennis-club'},{name:'tennis-club'}]);
});
test('permissions failure never tries to replace resources',async()=>{
  const methods=[];
  await assert.rejects(provision(env,async(url,options)=>{methods.push(options.method);return reply(null,403);}),/权限/);
  assert.deepEqual(methods,['GET']);
});
test('explicit database ID is used instead of locating or creating a database',async()=>{
  const calls=[];
  const result=await provision({...env,CF_D1_DATABASE_ID:id},async(url,options)=>{calls.push(url);assert.equal(options.method,'GET');return url.endsWith(id)?reply({uuid:id,name:'existing-training'}):reply({name:'tennis-club'});});
  assert.equal(result.databaseName,'existing-training');assert(calls[0].endsWith(id));
});
test('invalid resource names are rejected before accessing Cloudflare',async()=>{
  for(const extra of [{CF_ACCOUNT_ID:'wrong'},{CF_D1_DATABASE_ID:'local-tennis-club'},{CF_R2_BUCKET_NAME:'../bucket'},{CF_D1_DATABASE_NAME:'database\nENV=bad'}]){
    let calls=0;await assert.rejects(provision({...env,...extra},async()=>{calls++;}));assert.equal(calls,0);
  }
});
