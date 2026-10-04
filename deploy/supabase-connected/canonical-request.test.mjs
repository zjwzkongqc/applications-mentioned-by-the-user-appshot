import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRequest } from './canonical-request.mjs';
const origin = 'https://kvbxmvwtblwibhesnleh.supabase.co';
for (const path of ['/tennis-api', '/tennis-api/healthz', '/tennis-api/api/auth/me?club=sample', '/functions/v1/tennis-api', '/functions/v1/tennis-api/healthz']) {
  test('canonical route ' + path, () => {
    const request = new Request('http://internal.invalid' + path);
    const result = canonicalRequest(request, origin);
    assert.equal(result.url, origin + (path.startsWith('/functions/v1/') ? path : '/functions/v1' + path));
  });
}
for (const path of ['/', '/healthz', '/api/auth/me', '/tennis-api-other/healthz', '/functions/v1/tennis-api-other/healthz', '/other/tennis-api/healthz']) {
  test('reject route ' + path, () => assert.equal(canonicalRequest(new Request(origin + path), origin), null));
}
test('preserve POST body and signature path without trusting forwarded host', async () => {
  const request = new Request('http://internal.invalid/tennis-api/api/_owner/migration-import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'not-trusted.invalid', 'X-Tennis-Import-Signature': 'test-only' },
    body: '{"test":true}'
  });
  const result = canonicalRequest(request, origin);
  assert.equal(result.method, 'POST');
  assert.equal(result.url, origin + '/functions/v1/tennis-api/api/_owner/migration-import');
  assert.equal(result.headers.get('X-Tennis-Import-Signature'), 'test-only');
  assert.equal(await result.text(), '{"test":true}');
});
test('reject unapproved public origin', () => {
  for (const value of ['http://kvbxmvwtblwibhesnleh.supabase.co', 'https://example.com', origin + '/', origin + '/path']) {
    assert.throws(() => canonicalRequest(new Request(origin + '/tennis-api/healthz'), value));
  }
});
