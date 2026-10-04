import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import worker from '../src/worker.js';
const API='https://tennis-dazi-club-2026.divine-seal-5110.chatgpt.site',PAGES='https://zjwzkongqc.github.io';
const CODE_PATTERN=/^TC-(?:[A-F0-9]{8}-){4}[A-F0-9]{8}$/;
const nonce=()=>Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const hash=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('hex');
// Real SQLite and the checked-in migrations exercise D1's constraints, joins,
// and transactional rollback rather than replacing queries with canned rows.
export function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const migrations = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  t.after(() => sqlite.close());
  let failingSql;
  let beforeSql;
  const prepared = (sql, values = []) => ({
    bind(...bound) { return prepared(sql, bound); },
    async first(column) {
      const row = sqlite.prepare(sql).get(...values);
      return row ? column ? row[column] : { ...row } : null;
    },
    async all() { return { results: sqlite.prepare(sql).all(...values).map(row => ({ ...row })), success: true }; },
    async run() {
      if (beforeSql?.pattern.test(sql)) { const action = beforeSql.action; beforeSql = undefined; action(sqlite); }
      if (failingSql?.test(sql)) { failingSql = undefined; throw new Error('Injected D1 write failure'); }
      const result = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    }
  });
  const env = { DB: {
    prepare: sql => prepared(sql),
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  } };
  const objects=new Map();
  env.BUCKET={async put(key,bytes,metadata){objects.set(key,{bytes:new Uint8Array(bytes),metadata});},async get(key){const item=objects.get(key);return item?{body:item.bytes,httpMetadata:item.metadata.httpMetadata,arrayBuffer:async()=>item.bytes.slice().buffer}:null;},async delete(key){objects.delete(key);}};
  let ip = 1;
  async function call(path, { method = 'GET', token, accountToken, invite, body, raw, origin = PAGES, headers: extraHeaders = {}, address } = {}) {
    const headers = { Origin: origin, 'CF-Connecting-IP': address || `192.0.2.${ip}`, ...extraHeaders };
    if (token) headers['X-Tennis-Session'] = token;
    if (accountToken) headers['X-Tennis-Session'] = accountToken;
    if (invite) headers.Authorization = `Bearer ${invite}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await worker.fetch(new Request(API + path, { method, headers, body: raw??(body === undefined ? undefined : JSON.stringify(body)) }), env);
    return { response, status: response.status, data: response.headers.get('Content-Type')?.includes('application/json')?await response.json():response.headers.get('Content-Type')?.startsWith('image/')?new Uint8Array(await response.arrayBuffer()):await response.text() };
  }
  // These rows represent pre-upgrade browser identities. New visitors must
  // use signup; compatibility tests seed the historical state explicitly.
  async function createClub(nickname='Chris',token=nonce()) {
    ip++;
    const invite=nonce(),clubId=crypto.randomUUID(),memberId=crypto.randomUUID(),created=new Date().toISOString();
    sqlite.prepare('INSERT INTO clubs(id,invite_hash,name,slogan,owner_id,created_at) VALUES(?,?,?,?,?,?)').run(clubId,await hash(invite),`长期成长 ${ip}`,'一起挥拍',memberId,created);
    sqlite.prepare('INSERT INTO members(id,club_id,session_hash,nickname,bio,created_at) VALUES(?,?,?,?,?,?)').run(memberId,clubId,await hash(token),nickname,'',created);
    return {invite,token,clubId,memberId,registrationNonce:nonce()};
  }
  async function createLegacyMember(clubId,nickname='旧名片') {
    const memberId=crypto.randomUUID(),token=nonce();sqlite.prepare('INSERT INTO members(id,club_id,session_hash,nickname,bio,created_at) VALUES(?,?,?,?,?,?)').run(memberId,clubId,await hash(token),nickname,'',new Date().toISOString());
    return {status:201,data:{id:memberId,sessionToken:token}};
  }
  async function enableRecovery(club) {
    const enabled = await call('/api/auth/register', { method: 'POST', invite: club.invite, token: club.token, body: { registrationNonce: club.registrationNonce } });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
    assert.match(enabled.data.recoveryCode, CODE_PATTERN);
    assert.match(enabled.data.sessionToken, /^[a-f0-9]{64}$/);
    return { accountToken: enabled.data.sessionToken, recoveryCode: enabled.data.recoveryCode, account: enabled.data.account };
  }
  const login = (recoveryCode, options = {}) => call('/api/auth/login', { method: 'POST', body: { recoveryCode }, ...options });
  return { call, createClub, createLegacyMember, enableRecovery, login, sqlite, env,
    failOnce: pattern => { failingSql = pattern; },
    beforeOnce: (pattern, action) => { beforeSql = { pattern, action }; }
  };
}
