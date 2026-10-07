import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { handleWishes } from '../deploy/fresh/wishes.mjs';
import { createPostgresDatabase, postgresOptions } from '../supabase/functions/tennis-api/postgres.mjs';

// Opt in only with a disposable local PostgreSQL database. This test creates
// the exact fresh schema/role names; it must never run against a live project.
const databaseUrl = process.env.WISHES_TEST_DATABASE_URL;
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const token = 'a'.repeat(64), otherToken = 'b'.repeat(64), expiredToken = 'c'.repeat(64);
const hash = value => createHash('sha256').update(value).digest('hex');

test('fresh wishes migrate and run through the real PostgreSQL runner and adapter', { skip: !databaseUrl }, async t => {
  const address = new URL(databaseUrl);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname), 'Only a disposable loopback database is permitted');
  assert.match(address.pathname, /^\/wishes_test_[a-z0-9]+$/, 'Use a dedicated wishes_test_* database');
  const sql = postgres(databaseUrl, postgresOptions());
  let ownsSchema = false;
  t.after(async () => {
    try {
      if (ownsSchema) {
        await sql.unsafe('DROP SCHEMA IF EXISTS tennis_fresh CASCADE');
        await sql.unsafe('DROP ROLE IF EXISTS tennis_fresh_runner,authenticated,anon');
      }
    } finally { await sql.end({ timeout: 5 }); }
  });
  const existing = await sql.unsafe("SELECT nspname FROM pg_namespace WHERE nspname='tennis_fresh'");
  assert.equal(existing.length, 0, 'Refusing to modify an existing fresh schema');
  const oldRoles = await sql.unsafe("SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','tennis_fresh_runner')");
  assert.equal(oldRoles.length, 0, 'Use an isolated PostgreSQL instance without application roles');
  ownsSchema = true;
  await sql.unsafe(`
    CREATE ROLE anon NOLOGIN NOBYPASSRLS;
    CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
    CREATE ROLE tennis_fresh_runner NOLOGIN NOBYPASSRLS;
    CREATE SCHEMA tennis_fresh;
    REVOKE ALL ON SCHEMA tennis_fresh FROM PUBLIC;
    GRANT USAGE ON SCHEMA tennis_fresh TO tennis_fresh_runner;
    CREATE TABLE tennis_fresh.accounts(id text PRIMARY KEY);
    CREATE TABLE tennis_fresh.account_sessions(session_hash text PRIMARY KEY,account_id text NOT NULL REFERENCES tennis_fresh.accounts(id),expires_at bigint NOT NULL);
    CREATE TABLE tennis_fresh.members(id text PRIMARY KEY,club_id text NOT NULL,account_id text REFERENCES tennis_fresh.accounts(id),removed_at text);
    CREATE TABLE tennis_fresh.records(id text PRIMARY KEY,club_id text NOT NULL,member_id text NOT NULL,minutes bigint NOT NULL);
    CREATE TABLE tennis_fresh.checkins(id text PRIMARY KEY,club_id text NOT NULL,member_id text NOT NULL);
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA tennis_fresh TO tennis_fresh_runner;
  `);
  for (const table of ['accounts', 'account_sessions', 'members', 'records', 'checkins']) {
    await sql.unsafe(`ALTER TABLE tennis_fresh.${table} ENABLE ROW LEVEL SECURITY; CREATE POLICY runner ON tennis_fresh.${table} FOR ALL TO tennis_fresh_runner USING (true) WITH CHECK (true)`);
  }
  await sql.unsafe("INSERT INTO tennis_fresh.accounts(id) VALUES ('owner'),('other')");
  await sql.unsafe('INSERT INTO tennis_fresh.account_sessions(session_hash,account_id,expires_at) VALUES ($1,$2,$3),($4,$5,$3),($6,$2,$7)', [hash(token), 'owner', Date.now() + 3600000, hash(otherToken), 'other', hash(expiredToken), Date.now() - 1000]);
  await sql.unsafe("INSERT INTO tennis_fresh.members(id,club_id,account_id,removed_at) VALUES ('owner-1','club-1','owner',NULL),('owner-2','club-2','owner','2026-01-01'),('other-1','club-1','other',NULL)");
  await sql.unsafe("INSERT INTO tennis_fresh.records(id,club_id,member_id,minutes) VALUES ('training-1','club-1','owner-1',60),('training-2','club-2','owner-2',31),('training-3','club-1','other-1',120),('wrong-grain','club-elsewhere','owner-1',500)");
  await sql.unsafe("INSERT INTO tennis_fresh.checkins(id,club_id,member_id) VALUES ('no-duration','club-1','owner-1')");
  await sql.unsafe(await readFile(new URL('../deploy/fresh/migrations/20261007064618_fresh_training_wishes.sql', import.meta.url), 'utf8'));

  // Deliberately identical transaction scoping to deploy/fresh/index.ts.
  const within = (options, fn) => sql.begin(options, async tx => {
    await tx.unsafe('SET LOCAL ROLE tennis_fresh_runner');
    await tx.unsafe('SET LOCAL search_path=tennis_fresh,pg_catalog');
    return fn(tx);
  });
  const connection = {
    unsafe: (query, parameters = []) => within('isolation level serializable', tx => tx.unsafe(query, parameters)),
    begin: (options, fn) => within(options, fn)
  };
  const objects = new Map();
  const BUCKET = {
    async put(key, bytes, metadata) { objects.set(key, { body: bytes.slice(), ...metadata }); },
    async get(key) { return objects.get(key) || null; },
    async delete(key) { objects.delete(key); }
  };
  const env = { DB: createPostgresDatabase(connection), BUCKET };
  async function call(path = '/api/wishes', { method = 'GET', session = token, body, raw, alternateEnv = env } = {}) {
    const headers = { Origin: 'https://zjwzkongqc.github.io' };
    if (session) headers['X-Tennis-Session'] = session;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await handleWishes(new Request('https://tennis-test.supabase.co' + path, {
      method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body))
    }), alternateEnv);
    const isImage = response.headers.get('Content-Type')?.startsWith('image/');
    return { status: response.status, data: isImage ? new Uint8Array(await response.arrayBuffer()) : await response.json(), headers: response.headers };
  }
  const wishId = crypto.randomUUID(), path = `/api/wishes/${wishId}`, imagePath = path + '/image';

  await t.test('additive migration preserves rows and allows only the private runner role', async () => {
    const [{ relrowsecurity }] = await sql.unsafe("SELECT relrowsecurity FROM pg_class WHERE oid='tennis_fresh.training_wishes'::regclass");
    assert.equal(relrowsecurity, true);
    const [{ rolcanlogin, rolbypassrls }] = await sql.unsafe("SELECT rolcanlogin,rolbypassrls FROM pg_roles WHERE rolname='tennis_fresh_runner'");
    assert.equal(rolcanlogin, false); assert.equal(rolbypassrls, false);
    const [identity] = await connection.unsafe('SELECT current_user,current_schema() AS schema');
    assert.equal(identity.current_user, 'tennis_fresh_runner'); assert.equal(identity.schema, 'tennis_fresh');
    assert.equal((await sql.unsafe('SELECT count(*)::int AS n FROM tennis_fresh.records'))[0].n, 4);
    for (const role of ['anon', 'authenticated']) {
      const [rights] = await sql.unsafe("SELECT has_table_privilege($1,'tennis_fresh.training_wishes','SELECT,INSERT,UPDATE,DELETE') AS allowed", [role]);
      assert.equal(rights.allowed, false);
      await assert.rejects(() => sql.begin(async tx => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        return tx.unsafe('SELECT * FROM tennis_fresh.training_wishes');
      }), error => error.code === '42501');
    }
  });

  await t.test('SUM(bigint), empty totals and expired identity use production numeric parsers', async () => {
    const summary = await call();
    assert.equal(summary.status, 200);
    assert.equal(summary.data.totalMinutes, 91);
    assert.equal(summary.data.totalValueCents, 22750);
    assert.equal(summary.data.rateCentsPerHour, 15000);
    assert.equal((await call('/api/wishes', { session: otherToken })).data.totalValueCents, 30000);
    assert.equal((await call('/api/wishes', { session: expiredToken })).status, 401);
    assert.equal((await call('/api/wishes', { session: null })).status, 401);
    assert.deepEqual(summary.data.wishes, []);
  });

  await t.test('INSERT RETURNING is idempotent and binds Unicode names and integer prices', async () => {
    const input = { id: wishId, name: '🎾'.repeat(60), targetCents: 300001 };
    const created = await call('/api/wishes', { method: 'POST', body: input });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.wish.name, input.name);
    assert.equal(created.data.wish.targetCents, 300001);
    assert.equal(created.data.wish.imageUrl, null);
    assert.equal((await call('/api/wishes', { method: 'POST', body: input })).status, 200);
    assert.equal((await call('/api/wishes', { method: 'POST', body: { ...input, targetCents: 1 } })).status, 409);
    assert.equal((await call('/api/wishes', { method: 'POST', session: otherToken, body: input })).status, 409);
    assert.equal((await connection.unsafe('SELECT count(*)::int AS n FROM training_wishes'))[0].n, 1);
  });

  await t.test('UPDATE RETURNING supports edits and fulfill/undo without spending training value', async () => {
    const edited = await call(path, { method: 'PATCH', body: { name: '新球拍', targetCents: 12345 } });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    assert.equal(edited.data.wish.name, '新球拍'); assert.equal(edited.data.wish.targetCents, 12345);
    const fulfilled = await call(path, { method: 'PATCH', body: { fulfilled: true } });
    assert.equal(fulfilled.status, 200); assert.ok(fulfilled.data.wish.fulfilledAt);
    const repeated = await call(path, { method: 'PATCH', body: { fulfilled: true } });
    assert.equal(repeated.data.wish.fulfilledAt, fulfilled.data.wish.fulfilledAt);
    assert.equal((await call()).data.totalValueCents, 22750);
    assert.equal((await call(path, { method: 'PATCH', body: { fulfilled: false } })).data.wish.fulfilledAt, null);
    assert.equal((await call(path, { method: 'PATCH', session: otherToken, body: { name: 'intruder' } })).status, 404);
    assert.deepEqual((await call('/api/wishes', { session: otherToken })).data.wishes, []);
  });

  await t.test('nullable image compare-and-swap works for first upload, replacement and clearing', async () => {
    assert.equal((await call(imagePath, { method: 'DELETE' })).status, 200, 'Deleting a null image must type its null parameter');
    for (let i = 0; i < 2; i++) {
      const uploaded = await call(imagePath, { method: 'POST', raw: png });
      assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
      assert.equal(uploaded.data.wish.imageUrl, imagePath);
      assert.equal(objects.size, 1, 'A replacement cleans up the previous object');
      const loaded = await call(imagePath);
      assert.equal(loaded.status, 200); assert.deepEqual(loaded.data, png);
      assert.equal(loaded.headers.get('Cache-Control'), 'no-store');
      assert.equal((await call(imagePath, { session: otherToken })).status, 404);
      assert.equal((await call(imagePath, { method: 'POST', session: otherToken, raw: png })).status, 404);
    }
    const cleared = await call(imagePath, { method: 'DELETE' });
    assert.equal(cleared.status, 200); assert.equal(cleared.data.wish.imageUrl, null);
    assert.equal(objects.size, 0); assert.equal((await call(imagePath)).status, 404);
  });

  await t.test('a raced image write returns conflict and removes only the losing pending object', async () => {
    const winner = 'wishes/owner/concurrent-winner';
    const alternateEnv = { ...env, BUCKET: { ...BUCKET, async put(key, bytes, metadata) {
      await BUCKET.put(key, bytes, metadata);
      await BUCKET.put(winner, png, { httpMetadata: { contentType: 'image/png' } });
      await connection.unsafe('UPDATE training_wishes SET image_key=$1 WHERE id=$2', [winner, wishId]);
    } } };
    const lost = await call(imagePath, { method: 'POST', raw: png, alternateEnv });
    assert.equal(lost.status, 409, JSON.stringify(lost.data));
    assert.deepEqual([...objects.keys()], [winner]);
    assert.deepEqual((await call(imagePath)).data, png);
  });

  await t.test('editing/deleting training recomputes totals and wish DELETE RETURNING cleans its image', async () => {
    await connection.unsafe("UPDATE records SET minutes=600 WHERE id='training-1'");
    assert.equal((await call()).data.totalValueCents, 157750);
    await connection.unsafe("DELETE FROM records WHERE id IN ('training-1','training-2')");
    assert.equal((await call()).data.totalMinutes, 0);
    assert.equal((await call()).data.totalValueCents, 0);
    assert.equal((await call(path, { method: 'DELETE', session: otherToken })).status, 404);
    assert.equal((await call(path, { method: 'DELETE' })).status, 200);
    assert.equal(objects.size, 0);
    assert.deepEqual((await call()).data.wishes, []);
    assert.equal((await call(path, { method: 'DELETE' })).status, 404);
  });
});
