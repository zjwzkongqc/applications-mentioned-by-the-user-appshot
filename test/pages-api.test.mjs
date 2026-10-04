import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const api='https://tennis-dazi-club-2026.divine-seal-5110.chatgpt.site';
const origin='https://zjwzkongqc.github.io';
const invite='a'.repeat(64),token='b'.repeat(64);
const member={id:'test-member',nickname:'Chris'};
const env={DB:{prepare(sql){return {bind(){return {first:async()=>sql.includes('FROM clubs')?{id:'test-club'}:sql.includes('FROM members')?member:null};}};}}};
const request=(path,options={})=>new Request(api+path,options);

test('Pages preflight succeeds without touching the database',async()=>{
  const response=await worker.fetch(request('/api/profile',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type,x-tennis-session'}}),{});
  assert.equal(response.status,204);assert.equal(response.headers.get('Access-Control-Allow-Origin'),origin);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'),null);
});
test('preflight refuses untrusted origins and the cookie export endpoint',async()=>{
  for(const [path,source] of [['/api/profile','https://evil.example'],['/api/pages-session',origin]]){
    const response=await worker.fetch(request(path,{method:'OPTIONS',headers:{Origin:source,'Access-Control-Request-Method':'POST'}}),{});
    assert.equal(response.status,403);assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
  }
});
test('Pages can read authentication errors; other origins get no CORS grant',async()=>{
  for(const source of [origin,'https://evil.example']){
    const response=await worker.fetch(request('/api/board',{headers:{Origin:source}}),{DB:env.DB});
    assert.equal(response.status,401);assert.equal(response.headers.get('Access-Control-Allow-Origin'),source===origin?origin:null);
    assert.match(response.headers.get('Vary'),/Origin/);
  }
});
test('untrusted mutations are refused before database access',async()=>{
  const response=await worker.fetch(request('/api/clubs',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'}),{});
  assert.equal(response.status,403);
});
test('profile migration requires a same-origin POST with an existing cookie',async()=>{
  const headers={Origin:api,Authorization:`Bearer ${invite}`,Cookie:`tc_session=${token}`};
  const response=await worker.fetch(request('/api/pages-session',{method:'POST',headers}),env);
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{sessionToken:token});
  for(const extra of [{Origin:origin},{'X-Tennis-Session':token},{Cookie:''}]){
    const denied=await worker.fetch(request('/api/pages-session',{method:'POST',headers:{...headers,...extra}}),env);
    assert.ok([401,403].includes(denied.status));assert.equal(denied.headers.get('Access-Control-Allow-Origin'),null);
  }
});
