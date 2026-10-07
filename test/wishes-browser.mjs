// Opt-in local browser integration. Every API call runs the actual handlers
// against an in-memory SQLite database and private in-memory object storage.
// No requests or fixture records are sent to a deployed app.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import worker from '../src/worker.js';
import { handleWishes } from '../deploy/fresh/wishes.mjs';
import { wishFixture } from './wishes-helper.mjs';
import { buildFreshPages } from '../scripts/build-fresh-pages.mjs';

const { chromium } = await import(process.env.TENNIS_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.TENNIS_PLAYWRIGHT_MODULE).href : 'playwright');
const pageBase = 'https://zjwzkongqc.github.io/applications-mentioned-by-the-user-appshot/fresh/';
const pagesOrigin = new URL(pageBase).origin;
const apiOrigin = 'https://kvbxmvwtblwibhesnleh.supabase.co';
const prefix = '/functions/v1/tennis-fresh';
const artifacts = process.env.TENNIS_BROWSER_ARTIFACTS || '/tmp/tennis-wishes-browser';
const report = { passed: false, localOnly: true, checks: [], diagnostics: [] };
const cleanup = [];
const f = wishFixture({ after: fn => cleanup.push(fn) });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZuoAAAAASUVORK5CYII=', 'base64');
let browser, page, stage = 'fixture setup';
let holdNextWish = false, heldWish, releaseHeld;
const runtimeErrors = [], consoleErrors = [], apiFailures = [];
const check = (name, condition = true) => { assert(condition, name); report.checks.push(name); };
async function serve(request) {
  return await handleWishes(request, f.env) || worker.fetch(request, f.env);
}
async function api(route, token, { method = 'GET', data } = {}) {
  const headers = { Origin: pagesOrigin, 'X-Tennis-Session': token };
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const response = await serve(new Request(apiOrigin + route, { method, headers,
    body: data === undefined ? undefined : JSON.stringify(data) }));
  assert(response.ok, `${method} ${route}: ${response.status}`);
  return response.json();
}
const panel = () => page.locator('[data-wishes-panel]');
async function waitPanel() { await panel().waitFor(); await page.waitForFunction(() => { const total = document.querySelector('[data-wishes-panel] .wish-total'); return total && total.textContent !== '—'; }); }
async function waitValue(cents) {
  await page.waitForFunction(value => {
    const total = document.querySelector('[data-wishes-panel] .wish-total');
    return total && Number(total.textContent.replace(/[^\d.]/g, '')) === value / 100;
  }, cents);
}
async function enterGrowth() {
  if (await page.locator('[data-wishes-teaser] [data-wish-action="open"]').count()) await page.locator('[data-wishes-teaser] [data-wish-action="open"]').click();
  else await page.locator('.mobile-nav [data-action="tab"][data-tab="my"]').click();
  await waitPanel();
}
async function submitRecord(minutes, note) {
  await page.locator('.page-heading [data-action="training"]').click();
  await page.locator('#minutes').fill(String(minutes));
  await page.locator('input[name="training_project"][value="forehand"]').check();
  await page.locator('#record-note').fill(note);
  await page.locator('#record-form button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('#modal').open);
}
async function switchIdentity(recoveryCode) {
  await page.locator('[data-action="login"]:visible').first().click();
  await page.locator('#modal [data-action="recovery-login"]').click();
  await page.locator('#recovery-code').fill(recoveryCode);
  await page.locator('#auth-form button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('#modal').open);
  await page.locator('.shell').waitFor();
  await enterGrowth();
}

try {
  await buildFreshPages();
  const club = await f.createClub('球友甲');
  const recovered = await f.enableRecovery(club);
  const A = { token: recovered.accountToken, recoveryCode: recovered.recoveryCode, account: recovered.account };
  const started = await f.call('/api/auth/start', { method: 'POST', body: { nickname: '球友乙', startNonce: randomBytes(32).toString('hex') } });
  assert.equal(started.status, 201);
  const B = { token: started.data.sessionToken, recoveryCode: started.data.recoveryCode, account: started.data.account };
  assert.equal((await f.call('/api/profile', { method: 'POST', accountToken: B.token, invite: club.invite, body: { nickname: '球友乙', bio: '' } })).status, 201);
  await api('/api/wishes', B.token, { method: 'POST', data: { id: randomUUID(), name: '乙的跑鞋', targetCents: 80000 } });

  await fs.mkdir(artifacts, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: {
    cookies: [], origins: [{ origin: pagesOrigin, localStorage: [{ name: `tennis-club:account:${apiOrigin}:${pageBase}`, value: A.token }] }]
  } });
  await context.route('**/*', async route => {
    try {
      const req = route.request(), url = new URL(req.url());
      if (url.href.startsWith(pageBase)) {
        const rel = url.pathname.slice(new URL(pageBase).pathname.length) || 'index.html';
        assert(/^[a-zA-Z0-9_.-]+$/.test(rel), 'unexpected Pages path');
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
        await route.fulfill({ status: 200, contentType: types[path.extname(rel)] || 'text/plain', body: rel === 'config.js' ? (await fs.readFile(new URL('../dist/pages/fresh/config.js', import.meta.url), 'utf8')).replace('d8c317bf-c2c5-4847-ad6d-9dd062367a45', club.clubId) : await fs.readFile(new URL('../dist/pages/fresh/' + rel, import.meta.url)) });
        return;
      }
      assert.equal(url.origin, apiOrigin, 'test cannot contact external services');
      assert(url.pathname.startsWith(prefix + '/api/'), 'unexpected backend path');
      const normalized = apiOrigin + url.pathname.slice(prefix.length) + url.search;
      const response = await serve(new Request(normalized, { method: req.method(), headers: await req.allHeaders(), body: req.postDataBuffer() || undefined }));
      const result = { status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) };
      if (response.status >= 400) apiFailures.push({ path: url.pathname, status: response.status });
      if (holdNextWish && req.method() === 'GET' && url.pathname === prefix + '/api/wishes') {
        holdNextWish = false;
        heldWish?.();
        await new Promise(resolve => { releaseHeld = resolve; });
      }
      await route.fulfill(result);
    } catch (error) {
      report.diagnostics.push({ kind: 'route', message: error.message });
      await route.abort();
    }
  });
  page = await context.newPage();
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('dialog', dialog => dialog.accept());
  page.setDefaultTimeout(10000);
  stage = 'load private group';
  await page.goto(pageBase + '#c=' + club.clubId, { waitUntil: 'domcontentloaded' });
  await page.locator('.shell').waitFor();
  await enterGrowth();
  check('new account starts at zero', (await api('/api/wishes', A.token)).totalValueCents === 0);
  check('empty state offers a wish', await panel().locator('[data-wish-action="create"]').count() >= 1);

  stage = 'create wish with private image';
  await panel().locator('[data-wish-action="create"]').first().click();
  await page.locator('#wish-name').fill('我的第一支球拍');
  await page.locator('#wish-price').fill('3000');
  await page.locator('#wish-image').setInputFiles({ name: 'racket.png', mimeType: 'image/png', buffer: png });
  await page.locator('#wish-form button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('#modal').open);
  await panel().getByText('我的第一支球拍', { exact: true }).waitFor();
  let saved = await api('/api/wishes', A.token);
  const wishId = saved.wishes[0].id;
  check('wish stores exact price in cents', saved.wishes[0].targetCents === 300000);
  check('wish image uses private authenticated route', saved.wishes[0].imageUrl === `/api/wishes/${wishId}/image`);
  await page.waitForFunction(id => { const image = document.querySelector(`img[data-wish-image="${id}"]`); return image?.complete && image.naturalWidth > 0 && image.src.startsWith('blob:'); }, wishId);
  check('uploaded image renders successfully');

  stage = 'record training and calculate progress';
  await submitRecord(600, '浏览器验收：十小时训练');
  await page.waitForFunction(() => document.querySelector('[data-wishes-panel]')?.textContent.includes('50%'));
  saved = await api('/api/wishes', A.token);
  check('600 minutes produces exactly 1500 yuan', saved.totalMinutes === 600 && saved.totalValueCents === 150000);
  check('halfway to 3000 yuan wish is visible', /50%/.test(await panel().innerText()));
  check('remaining ten hours is visible', /10\s*小时/.test(await panel().innerText()));
  check('mobile page has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: path.join(artifacts, 'growth-mobile.png'), fullPage: true });
  await panel().screenshot({ path: path.join(artifacts, 'wishes-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  check('desktop page has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await panel().screenshot({ path: path.join(artifacts, 'wishes-desktop.png') });
  await page.setViewportSize({ width: 320, height: 740 });
  check('narrow mobile page has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.setViewportSize({ width: 390, height: 844 });

  stage = 'edit wish while older summary request is pending';
  const beforeEdit = new Promise(resolve => { heldWish = resolve; });
  holdNextWish = true;
  await page.evaluate(() => { void window.TennisWishes.refresh({ force: true }); });
  await beforeEdit;
  await panel().locator(`[data-wish-action="edit"][data-wish-id="${wishId}"]`).click();
  await page.locator('#wish-name').fill('我的进阶球拍');
  await page.locator('#wish-price').fill('6000.50');
  await page.locator('#wish-form button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('#modal').open);
  releaseHeld(); releaseHeld = null;
  await panel().getByText('我的进阶球拍', { exact: true }).waitFor();
  check('older pending response cannot hide a saved wish edit');
  saved = await api('/api/wishes', A.token);
  check('edit preserves decimal price precisely', saved.wishes[0].targetCents === 600050);
  check('editing keeps the original image', !!saved.wishes[0].imageUrl);

  stage = 'fulfill without deducting training value';
  await panel().locator(`[data-wish-action="fulfill"][data-wish-id="${wishId}"]`).click();
  await page.locator('#wish-action-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('[data-wishes-panel] [data-wish-action="reopen"]'));
  saved = await api('/api/wishes', A.token);
  check('fulfillment is saved without subtracting total', !!saved.wishes[0].fulfilledAt && saved.totalValueCents === 150000);

  stage = 'training add edit delete refresh';
  await submitRecord(60, '浏览器验收：可修改的训练');
  saved = await api('/api/wishes', A.token);
  check('new record increases training equivalent', saved.totalValueCents === 165000);
  await waitValue(165000); check('new record refreshes visible equivalent');
  const record = (await f.call('/api/board?club=' + club.clubId, { accountToken: A.token })).data.records.find(row => row.note === '浏览器验收：可修改的训练');
  await page.locator(`[data-action="edit-record"][data-id="${record.id}"]`).click();
  await page.locator('#minutes').fill('120');
  await page.locator('#record-form button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('#modal').open);
  check('editing record recalculates equivalent', (await api('/api/wishes', A.token)).totalValueCents === 180000);
  await waitValue(180000); check('record edit refreshes visible equivalent');
  await page.locator(`[data-action="delete-record"][data-id="${record.id}"]`).click();
  await page.locator('#delete-form button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('#modal').open);
  check('deleting record removes its contribution', (await api('/api/wishes', A.token)).totalValueCents === 150000);
  await waitValue(150000); check('record deletion refreshes visible equivalent');

  stage = 'reload and reopen fulfilled wish';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.shell').waitFor();
  await enterGrowth();
  await panel().getByText('我的进阶球拍', { exact: true }).waitFor();
  check('fulfilled wish survives reload', await panel().locator('[data-wish-action="reopen"]').count() === 1);
  await panel().locator('[data-wish-action="reopen"]').click();
  await page.locator('#wish-action-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('[data-wishes-panel] [data-wish-action="fulfill"]'));
  check('reopened wish preserves total', (await api('/api/wishes', A.token)).totalValueCents === 150000);

  stage = 'switch identity while old private response is pending';
  const held = new Promise(resolve => { heldWish = resolve; });
  holdNextWish = true;
  await page.evaluate(() => { void window.TennisWishes.refresh({ force: true }); });
  await held;
  await switchIdentity(B.recoveryCode);
  releaseHeld(); releaseHeld = null;
  await panel().getByText('乙的跑鞋', { exact: true }).waitFor();
  check('switching identities hides previous account wishes', !(await panel().innerText()).includes('我的进阶球拍'));
  check('second account has independent zero total', (await api('/api/wishes', B.token)).totalValueCents === 0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.shell').waitFor(); await enterGrowth();
  await panel().getByText('乙的跑鞋', { exact: true }).waitFor();
  check('new account session survives reload without old data', !(await panel().innerText()).includes('我的进阶球拍'));
  check('no browser runtime errors', runtimeErrors.length === 0);
  check('no browser console errors', consoleErrors.length === 0);
  check('all local API responses succeeded', apiFailures.length === 0);
  report.passed = true;
} catch (error) {
  report.failedStage = stage;
  report.error = error.message;
  if (page) {
    try { await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }); } catch {}
    try { report.visibleForms = await page.locator('.form-error, .error-panel').allTextContents(); } catch {}
  }
} finally {
  releaseHeld?.();
  report.diagnostics.push(...runtimeErrors.map(message => ({ kind: 'runtime', message })), ...consoleErrors.map(message => ({ kind: 'console', message })), ...apiFailures.map(failure => ({ kind: 'http', ...failure })));
  if (browser) await browser.close();
  for (const fn of cleanup.reverse()) await fn();
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
if (!report.passed) process.exitCode = 1;
