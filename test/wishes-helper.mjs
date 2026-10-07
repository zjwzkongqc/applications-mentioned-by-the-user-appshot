import { fixture } from './helpers.mjs';
import { handleWishes } from '../deploy/fresh/wishes.mjs';

// Match the additive fresh schema with SQLite's equivalent integer/check types.
// Exercise actual joins, constraints, RETURNING writes and the existing auth API.
export function wishFixture(t) {
  const f = fixture(t);
  f.sqlite.exec(`CREATE TABLE training_wishes (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 60),
    target_cents INTEGER NOT NULL CHECK(target_cents BETWEEN 1 AND 100000000),
    image_key TEXT,
    fulfilled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX training_wishes_account_created_idx ON training_wishes(account_id,created_at DESC,id);`);
  const wishCall = async (path = '/api/wishes', { method = 'GET', accountToken, token, body, raw, origin = 'https://zjwzkongqc.github.io', headers: extraHeaders = {}, env = f.env } = {}) => {
    const headers = { ...extraHeaders };
    if (origin !== null) headers.Origin = origin;
    if (token || accountToken) headers['X-Tennis-Session'] = accountToken || token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await handleWishes(new Request('https://kvbxmvwtblwibhesnleh.supabase.co' + path, {
      method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body))
    }), env);
    if (!response) return null;
    const type = response.headers.get('Content-Type') || '';
    return { response, status: response.status, data: type.includes('application/json') ? await response.json() : type.startsWith('image/') ? new Uint8Array(await response.arrayBuffer()) : await response.text() };
  };
  return { ...f, wishCall };
}
