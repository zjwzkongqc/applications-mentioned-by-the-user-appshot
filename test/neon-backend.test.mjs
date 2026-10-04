import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { createNeonBucket, neonOrigin, neonStorageOrigin, neonS3Options } from '../neon/functions/tennis-api/storage.mjs';
import { createNeonRuntime, createNeonFunction, neonPostgresOptions } from '../neon/functions/tennis-api/runtime.mjs';
import { createEdgeHandler } from '../supabase/functions/tennis-api/handler.mjs';
import { migrationConfig } from '../supabase/functions/tennis-api/migration-config.mjs';
import { TABLE_NAMES } from '../supabase/functions/tennis-api/import.mjs';
import { fixture } from './helpers.mjs';
import worker from '../src/worker.js';

const ORIGIN = 'https://br-test-tennisapi.compute.c-4.ap-southeast-1.aws.neon.tech';
const STORAGE = 'https://br-test.storage.c-4.ap-southeast-1.aws.neon.tech';
const PAGES = 'https://zjwzkongqc.github.io';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7ioAAAAASUVORK5CYII=', 'base64');
const PRIVATE = 'test-only-private-credential';
const nonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const ENV = { TENNIS_PUBLIC_ORIGIN: ORIGIN, TENNIS_BUCKET: 'tennis-avatars',
  DATABASE_URL_UNPOOLED: 'postgresql://test:private-test-password@ep-test.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
  AWS_ENDPOINT_URL_S3: STORAGE, AWS_REGION: 'ap-southeast-1', AWS_ACCESS_KEY_ID: 'test-only-access-key', AWS_SECRET_ACCESS_KEY: PRIVATE };
const commands = Object.fromEntries(['PutObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand', 'GetBucketAclCommand', 'GetBucketPolicyCommand'].map(name => [name, class { constructor(input) { this.name = name; this.input = input; } }]));
function s3Fixture({ enforceCondition = true, acl, policy } = {}) {
  const calls = [], objects = new Map();
  const client = { async send(command) {
    const { name, input } = command; calls.push({ name, input });
    if (name === 'GetBucketAclCommand') return acl || { Owner: { ID: 'private-owner' }, Grants: [{ Permission: 'FULL_CONTROL', Grantee: { Type: 'CanonicalUser', ID: 'private-owner' } }] };
    if (name === 'GetBucketPolicyCommand') {
      if (policy) return { Policy: JSON.stringify(policy) };
      throw Object.assign(new Error('private policy ' + PRIVATE), { name: 'NoSuchBucketPolicy', $metadata: { httpStatusCode: 404 } });
    }
    if (name === 'PutObjectCommand') {
      if (enforceCondition && input.IfNoneMatch === '*' && objects.has(input.Key)) throw Object.assign(new Error('private conflict ' + PRIVATE), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
      objects.set(input.Key, { bytes: Uint8Array.from(input.Body), type: input.ContentType }); return {};
    }
    if (name === 'GetObjectCommand') {
      const object = objects.get(input.Key);
      if (!object) throw Object.assign(new Error('private missing ' + PRIVATE), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      return { ContentType: object.type, ContentLength: object.bytes.length, Body: Readable.from([Buffer.from(object.bytes)]) };
    }
    if (name === 'DeleteObjectCommand') { objects.delete(input.Key); return {}; }
    throw new Error('Unexpected S3 command');
  } };
  return { client, calls, objects, bucket: createNeonBucket({ client, commands }) };
}
function receipt() {
  return { formatVersion: 1, appId: 'tennis-dazi-club-2026', schemaVersion: 5, ...migrationConfig,
    toApiOrigin: ORIGIN, credentialsPreserved: true, sourceSnapshotSha256: 'b'.repeat(64),
    importedAt: new Date().toISOString(), avatarCount: 0, tableCounts: Object.fromEntries(TABLE_NAMES.map(name => [name, 0])) };
}
function database(state = receipt()) {
  return { prepare() { return { bind() { return this; }, async first() { return state ? { metadata: state } : null; } }; } };
}
function request(path, { method = 'GET', body, raw, headers = {}, origin = PAGES } = {}) {
  return new Request(ORIGIN + path, { method, headers: { ...(origin ? { Origin: origin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? raw : JSON.stringify(body) });
}

test('Neon platform origins are explicit HTTPS origins in supported regions', () => {
  assert.equal(neonOrigin(ORIGIN), ORIGIN); assert.equal(neonStorageOrigin(STORAGE), STORAGE);
  for (const value of [ORIGIN + '/', ORIGIN + '/api', ORIGIN + '?token=private', ORIGIN + '#x', ORIGIN.replace('https:', 'http:'), ORIGIN.replace('br-test-', 'user:pass@br-test-'), 'https://attacker.test', ORIGIN + '.attacker.test', ORIGIN.replace('ap-southeast-1', 'invalid-region'), STORAGE]) assert.throws(() => neonOrigin(value));
  assert.throws(() => neonStorageOrigin(ORIGIN));
});
test('injected S3 configuration uses private credentials and mandatory path addressing without redirects', () => {
  const options = neonS3Options(ENV);
  assert.equal(options.endpoint, STORAGE); assert.equal(options.forcePathStyle, true); assert.equal(options.followRegionRedirects, false); assert.equal(options.maxAttempts, 1);
  assert.equal(options.credentials.secretAccessKey, PRIVATE);
  for (const changes of [{ AWS_SECRET_ACCESS_KEY: undefined }, { AWS_ACCESS_KEY_ID: 'invalid\nkey' }, { AWS_ENDPOINT_URL_S3: 'https://attacker.test' }, { AWS_REGION: 'us-east-2' }]) assert.throws(() => neonS3Options({ ...ENV, ...changes }));
});
test('direct PostgreSQL transactions enforce certificate verification and never print driver notices', () => {
  const options = neonPostgresOptions(ENV); assert.equal(options.ssl.rejectUnauthorized, true); assert.equal(options.max, 1); assert.equal(options.prepare, false); assert.equal(options.onnotice({ private: PRIVATE }), undefined);
  for (const connection of [undefined, ENV.DATABASE_URL_UNPOOLED.replace('ep-test.', 'ep-test-pooler.'), ENV.DATABASE_URL_UNPOOLED.replace('neon.tech', 'attacker.test'), 'http://attacker.test', ENV.DATABASE_URL_UNPOOLED.replace('5432', '5433') + '#x']) assert.throws(() => neonPostgresOptions({ ...ENV, DATABASE_URL_UNPOOLED: connection }));
  assert.throws(() => neonPostgresOptions({ ...ENV, TENNIS_DB_CA_PEM: 'invalid cert' }));
});
test('S3 avatars and training photos stay private and preserve bytes through both read interfaces', async () => {
  const f = s3Fixture(), key = 'photos/club/member/photo?one=1#x';
  await f.bucket.put(key, PNG, { httpMetadata: { contentType: 'image/png' } });
  const image = await f.bucket.get(key); assert.equal(image.size, PNG.length); assert.equal(image.httpMetadata.contentType, 'image/png'); assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
  const second = await f.bucket.get(key); assert.deepEqual(Buffer.from(await new Response(second.body).arrayBuffer()), PNG);
  await f.bucket.delete(key); assert.equal(await f.bucket.get(key), null);
  for (const { input } of f.calls) { assert.equal(input.Bucket, 'tennis-avatars'); assert.equal(Object.hasOwn(input, 'ACL'), false); assert.equal(JSON.stringify(input).includes(PRIVATE), false); }
  const upload = f.calls.find(call => call.name === 'PutObjectCommand').input;
  assert.equal(upload.CacheControl, 'private, no-store'); assert.equal(upload.ContentLength, PNG.length);
});
test('invalid object paths, content types, and oversized writes make no SDK requests', async () => {
  const f = s3Fixture();
  for (const key of ['', '../outside', '/absolute', 'photos/../outside', 'photos//outside', 'photos\\outside']) {
    await assert.rejects(() => f.bucket.get(key)); await assert.rejects(() => f.bucket.delete(key)); await assert.rejects(() => f.bucket.put(key, PNG, { httpMetadata: { contentType: 'image/png' } }));
  }
  await assert.rejects(() => f.bucket.put('valid', PNG, { httpMetadata: { contentType: 'text/html' } }));
  await assert.rejects(() => f.bucket.put('valid', new Uint8Array(2 * 1024 * 1024 + 1), { httpMetadata: { contentType: 'image/png' } }));
  assert.equal(f.calls.length, 0);
});
test('Storage errors discard SDK credential details and hostile response metadata', async () => {
  const failures = [{ ContentType: 'text/html', Body: Readable.from([PNG]) }, { ContentType: 'image/png', ContentLength: 2 * 1024 * 1024 + 1, Body: Readable.from([PNG]) }];
  for (const response of failures) {
    const bucket = createNeonBucket({ client: { async send() { return response; } }, commands });
    await assert.rejects(() => bucket.get('valid'), error => error.message === 'Private image metadata is invalid.' && !error.message.includes(PRIVATE));
  }
  const bucket = createNeonBucket({ client: { async send() { throw new Error('SDK exposed ' + PRIVATE); } }, commands });
  for (const call of [() => bucket.get('valid'), () => bucket.put('valid', PNG, { httpMetadata: { contentType: 'image/png' } }), () => bucket.delete('valid')]) await assert.rejects(call, error => error.message === 'Private Storage request failed.' && error.cause === undefined);
});
test('unknown-length and failed image streams are bounded and upstream messages remain private', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; } });
  const bucket = createNeonBucket({ client: { async send() { return { ContentType: 'image/png', Body: body }; } }, commands });
  const object = await bucket.get('photos/valid'); assert.equal(object.size, null);
  await assert.rejects(() => object.arrayBuffer(), error => error.message === 'Private image read failed.'); assert.equal(cancelled, true);
  const broken = createNeonBucket({ client: { async send() { return { ContentType: 'image/png', Body: new ReadableStream({ pull() { throw new Error(PRIVATE); } }) }; } }, commands });
  await assert.rejects(() => (broken.get('photos/valid').then(image => image.arrayBuffer())), error => error.message === 'Private image read failed.' && error.cause === undefined);
});
test('private migration checks reject public or external bucket grants before any object writes', async () => {
  for (const configuration of [
    { acl: { Owner: { ID: 'private-owner' }, Grants: [{ Permission: 'READ', Grantee: { Type: 'Group', URI: 'http://acs.amazonaws.com/groups/global/AllUsers' } }] } },
    { acl: { Owner: { ID: 'private-owner' }, Grants: [{ Permission: 'FULL_CONTROL', Grantee: { Type: 'CanonicalUser', ID: 'another-owner' } }] } },
    { policy: { Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: '*' }] } }
  ]) {
    const f = s3Fixture(configuration); await assert.rejects(() => f.bucket.importBucket.assertPrivate());
    assert.equal(f.calls.some(call => call.name === 'PutObjectCommand'), false);
  }
});
test('migration proves conditional-write support before staging member media and retains prior bytes on conflict', async () => {
  const f = s3Fixture(); await f.bucket.importBucket.assertPrivate(); assert.equal(f.objects.size, 0);
  const puts = f.calls.filter(call => call.name === 'PutObjectCommand'); assert.equal(puts.length, 2); assert.equal(puts[0].input.IfNoneMatch, '*'); assert.match(puts[0].input.Key, /^migration-capability-probe\/[-a-f0-9]{36}$/);
  await f.bucket.importBucket.upload('photos/member/original', PNG, 'image/png');
  await assert.rejects(() => f.bucket.importBucket.upload('photos/member/original', PNG.subarray(0, 12), 'image/png'), error => error.existingObject === true && !error.message.includes(PRIVATE));
  assert.deepEqual(Buffer.from((await f.bucket.importBucket.download('photos/member/original')).bytes), PNG);
});
test('a provider ignoring conditional uploads cannot import real member objects', async () => {
  const f = s3Fixture({ enforceCondition: false });
  await assert.rejects(() => f.bucket.importBucket.assertPrivate(), /does not enforce conditional uploads/);
  assert.equal(f.objects.size, 0); assert.equal(f.calls.filter(call => call.name === 'PutObjectCommand').every(call => call.input.Key.startsWith('migration-capability-probe/')), true);
});
test('Neon routes preserve account headers, trusted canonical origin, query strings, CORS and unprefixed cookies', async () => {
  const seen = [];
  const handler = createEdgeHandler({ publicOrigin: ORIGIN, apiPrefix: '', validatePublicOrigin: neonOrigin, DB: database(), BUCKET: {},
    migrationId: migrationConfig.migrationId, migrationFromOrigin: migrationConfig.fromApiOrigin, migrationPageBaseUrl: migrationConfig.pageBaseUrl,
    worker: { async fetch(input) { seen.push(input); return new Response('{}', { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'tc_registration_legacy=test; Path=/api/auth/register; HttpOnly; Secure' } }); } } });
  const session = nonce(), invite = nonce();
  const response = await handler(request('/api/board?month=2026-10', { headers: { Authorization: 'Bearer ' + invite, 'X-Tennis-Session': session, 'CF-Connecting-IP': 'attacker-spoof', 'X-Forwarded-Host': 'attacker.test' } }));
  assert.equal(response.status, 200); assert.match(response.headers.get('Set-Cookie'), /Path=\/api\/auth\/register;/);
  assert.equal(seen[0].url, ORIGIN + '/api/board?month=2026-10'); assert.equal(seen[0].headers.get('X-Tennis-Session'), session); assert.equal(seen[0].headers.get('Authorization'), 'Bearer ' + invite); assert.equal(seen[0].headers.has('X-Forwarded-Host'), false); assert.notEqual(seen[0].headers.get('CF-Connecting-IP'), 'attacker-spoof');
  const denied = await handler(request('/api/records', { method: 'POST', origin: 'https://attacker.test', body: {} })); assert.equal(denied.status, 403); assert.equal(seen.length, 1);
  const options = await handler(request('/api/migration/validate', { method: 'OPTIONS' })); assert.equal(options.status, 204); assert.equal(options.headers.get('Access-Control-Allow-Origin'), PAGES);
  assert.equal((await handler(request('/functions/v1/tennis-api/api/board'))).status, 404);
});
test('runtime requires trusted deployment configuration before opening clients and empty migrations stay closed', async () => {
  let clients = 0, workerCalls = 0;
  const dependencies = { worker: { async fetch() { workerCalls++; return new Response('{}'); } },
    postgres(_url, options) { clients++; assert.equal(options.ssl.rejectUnauthorized, true); return { async unsafe() { return []; }, async begin(_level, callback) { return callback(this); } }; },
    S3Client: class { constructor(options) { clients++; assert.equal(options.forcePathStyle, true); } async send() { throw new Error(PRIVATE); } }, commands };
  const invalid = createNeonFunction({ ...dependencies, environment: { ...ENV, TENNIS_PUBLIC_ORIGIN: undefined } });
  const response = await invalid.fetch(request('/api/board')); assert.equal(response.status, 503); assert.equal(clients, 0); assert.equal((await response.text()).includes(PRIVATE), false);
  const handler = createNeonRuntime({ ...dependencies, environment: ENV });
  assert.equal((await handler(request('/api/auth/start', { method: 'POST', body: { nickname: '球友', startNonce: nonce() } }))).status, 503);
  assert.deepEqual(await (await handler(request('/healthz'))).json(), { ok: true, maintenance: true }); assert.equal(workerCalls, 0);
  assert.equal((await handler(request('/api/_owner/migration-import', { method: 'POST', origin: undefined, body: {} }))).status, 404);
  const maintenance = createNeonRuntime({ environment: { ...ENV, MAINTENANCE_MODE: '1' } });
  assert.equal((await maintenance(request('/api/board'))).status, 503); assert.deepEqual(await (await maintenance(request('/healthz'))).json(), { ok: true, maintenance: true });
});
test('the unchanged API authenticates nickname accounts across devices and enforces private photo ownership on Neon routes', async t => {
  const f = fixture(t), storage = s3Fixture();
  const DB = { ...f.env.DB, prepare(sql) { return sql.includes('tennis_migration_receipt') ? database().prepare(sql) : f.env.DB.prepare(sql); } };
  const handler = createEdgeHandler({ worker, DB, BUCKET: storage.bucket, publicOrigin: ORIGIN, apiPrefix: '', validatePublicOrigin: neonOrigin,
    migrationId: migrationConfig.migrationId, migrationFromOrigin: migrationConfig.fromApiOrigin, migrationPageBaseUrl: migrationConfig.pageBaseUrl });
  const call = async (path, options = {}) => {
    const response = await handler(request(path, options)); return { status: response.status, data: response.headers.get('Content-Type')?.startsWith('image/') ? Buffer.from(await response.arrayBuffer()) : await response.json() };
  };
  const first = await call('/api/auth/start', { method: 'POST', body: { nickname: '同名', startNonce: nonce() } }); assert.equal(first.status, 201);
  const second = await call('/api/auth/start', { method: 'POST', body: { nickname: '同名', startNonce: nonce() } }); assert.equal(second.status, 201); assert.notEqual(first.data.account.id, second.data.account.id);
  const A = { 'X-Tennis-Session': first.data.sessionToken }, B = { 'X-Tennis-Session': second.data.sessionToken };
  const club = await call('/api/clubs', { method: 'POST', headers: A, body: { name: '长期成长', nickname: 'A', slogan: '' } }); assert.equal(club.status, 201);
  const invite = club.data.invite;
  assert.equal((await call('/api/profile', { method: 'POST', headers: { ...B, Authorization: 'Bearer ' + invite }, body: { nickname: 'B', bio: '' } })).status, 201);
  const board = await call('/api/board', { headers: { ...A, Authorization: 'Bearer ' + invite } }); assert.equal(board.status, 200);
  const path = p => p + '?club=' + board.data.club.id, skills = { forehand: 0, backhand: null, serve: 7, return_skill: null, net: 4, footwork: 6 }, id = crypto.randomUUID();
  assert.equal((await call(path('/api/ratings'), { method: 'POST', headers: A, body: { month: '2026-10', skills } })).status, 200);
  assert.equal((await call(path('/api/records'), { method: 'POST', headers: A, body: { id, playDate: '2026-10-04', minutes: 45, mood: '认真练球', skills, trainingProjects: ['serve'], trainingContent: '练发球', trainingEffect: 'improved', nextPlan: '继续练发球' } })).status, 201);
  assert.equal((await call(path('/api/records/' + id + '/photos'), { method: 'POST', headers: B, raw: PNG })).status, 403);
  const photo = await call(path('/api/records/' + id + '/photos'), { method: 'POST', headers: A, raw: PNG }); assert.equal(photo.status, 201, JSON.stringify(photo.data));
  assert.deepEqual((await call(path('/api/photos/' + photo.data.id), { headers: B })).data, PNG);
  assert.equal((await call('/api/photos/' + photo.data.id, { headers: { Authorization: 'Bearer ' + invite } })).status, 401);
  assert.equal((await call(path('/api/photos/' + photo.data.id), { method: 'DELETE', headers: B })).status, 403);
  const recovered = await call('/api/auth/login', { method: 'POST', body: { recoveryCode: first.data.recoveryCode } }); assert.equal(recovered.status, 200);
  const remembered = await call(path('/api/board'), { headers: { 'X-Tennis-Session': recovered.data.sessionToken } }); assert.equal(remembered.data.me, board.data.me); assert.equal(remembered.data.members.find(member => member.id === board.data.me).rating.forehand, 0); assert.equal(remembered.data.members.find(member => member.id === board.data.me).rating.backhand, null);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM account_credentials').get().n, 0);
});
test('the deployable ZIP contains one complete Node24 ESM module and fails closed before configuration', async () => {
  const zip = unzipSync(await readFile(new URL('../dist/neon/function.zip', import.meta.url)));
  assert.deepEqual(Object.keys(zip), ['index.mjs']); assert.equal(zip['index.mjs'].length > 100000, true);
  const source = new TextDecoder().decode(zip['index.mjs']);
  assert.match(source, /createRequire/); assert.match(source, /rejectUnauthorized: true/); assert.equal(source.includes(PRIVATE), false); assert.equal(source.includes('npm:postgres'), false);
  const module = await import('../dist/neon/index.mjs'); assert.equal(typeof module.default.fetch, 'function');
  assert.equal((await module.default.fetch(request('/api/board'))).status, 503);
});
