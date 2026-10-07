// Opt-in browser acceptance against real in-memory SQLite, existing app/auth
// handlers and the fresh notebook policy. All network requests are intercepted;
// no users, records or sessions are created in the deployed application.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import worker from '../src/worker.js';
import { handleWishes } from '../deploy/fresh/wishes.mjs';
import { createNotebookPolicy } from '../deploy/fresh/notebook.mjs';
import { wishFixture } from './wishes-helper.mjs';
import { buildFreshPages } from '../scripts/build-fresh-pages.mjs';

const { chromium } = await import(process.env.TENNIS_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.TENNIS_PLAYWRIGHT_MODULE).href : 'playwright');
const pageBase = 'https://zjwzkongqc.github.io/applications-mentioned-by-the-user-appshot/fresh/';
const pagesOrigin = new URL(pageBase).origin;
const apiOrigin = 'https://kvbxmvwtblwibhesnleh.supabase.co';
const prefix = '/functions/v1/tennis-fresh';
const artifacts = process.env.TENNIS_BROWSER_ARTIFACTS || '/tmp/tennis-notebook-browser';
const report = { passed: false, localOnly: true, checks: [], diagnostics: [] };
const cleanup = [], runtimeErrors = [], apiFailures = [];
const f = wishFixture({ after: fn => cleanup.push(fn) });
const check = (name, condition = true) => { assert(condition, name); report.checks.push(name); };
let browser, page, stage = 'fixture setup';

async function recoveryLogin(code) {
  await page.locator('[data-action="recovery-login"]:visible').first().click();
  await page.locator('#recovery-code').fill(code);
  await page.locator('#auth-form button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('#modal').open);
}
async function logout() {
  await page.locator('[data-action="logout"]:visible').first().click();
  await page.locator('.notebook-welcome').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-action="logout"]'));
}
async function wishValue(cents) {
  await page.waitForFunction(value => {
    const total = document.querySelector('[data-wishes-panel] .wish-total');
    return total && Number(total.textContent.replace(/[^\d.]/g, '')) === value / 100;
  }, cents);
}
const noCreate = async () => !(await page.locator('#create-form').count()) && !/创建群小本本|给你们的群开一本|再为你们开一本/.test(await page.locator('body').innerText());

try {
  await fs.mkdir(artifacts, { recursive: true });
  await buildFreshPages();
  const active = await f.createClub('球友甲'), savedA = await f.enableRecovery(active);
  const archived = await f.createClub('球友乙'), savedB = await f.enableRecovery(archived);
  f.sqlite.prepare('UPDATE clubs SET name=? WHERE id=?').run('教练，我想打网球', active.clubId);
  f.sqlite.prepare('UPDATE clubs SET name=? WHERE id=?').run('网球搭子', archived.clubId);
  assert.equal((await f.call('/api/profile', { method: 'POST', accountToken: savedA.accountToken, invite: archived.invite, body: { nickname: '甲的旧名片', bio: '' } })).status, 201);
  for (const [club, token, minutes, note] of [
    [active, savedA.accountToken, 60, '甲在现有记录本的训练'],
    [archived, savedA.accountToken, 30, '甲已归档的训练'],
    [archived, savedB.accountToken, 120, '乙已归档的训练']
  ]) assert.equal((await f.call('/api/records?club=' + club.clubId, { method: 'POST', accountToken: token,
    body: { id: randomUUID(), playDate: '2026-01-20', minutes, mood: '认真练球', note } })).status, 201);
  for (const [token, name] of [[savedA.accountToken, '甲的私密球拍'], [savedB.accountToken, '乙的私密旅行']]) {
    assert.equal((await f.wishCall('/api/wishes', { method: 'POST', accountToken: token,
      body: { id: randomUUID(), name, targetCents: 300000 } })).status, 201);
  }
  const publicCard = await f.call('/api/share?club=' + active.clubId, { method: 'POST', accountToken: savedA.accountToken, body: { enabled: true } });
  assert.equal(publicCard.status, 200);
  const policy = createNotebookPolicy({ activeClubId: active.clubId });
  async function serve(request) {
    const blocked = await policy.before(request, f.env);
    if (blocked) return blocked;
    return policy.after(request, await handleWishes(request, f.env) || await worker.fetch(request, f.env));
  }
  browser = await chromium.launch({ headless: true });
  async function contextFor(token) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: {
      cookies: [], origins: token ? [{ origin: pagesOrigin, localStorage: [{ name: `tennis-club:account:${apiOrigin}:${pageBase}`, value: token }] }] : []
    } });
    await context.route('**/*', async route => {
      try {
        const req = route.request(), url = new URL(req.url());
        if (url.href.startsWith(pageBase)) {
          const rel = url.pathname.slice(new URL(pageBase).pathname.length) || 'index.html';
          assert(/^[a-zA-Z0-9_.-]+$/.test(rel), 'unexpected Pages path');
          let body = await fs.readFile(new URL('../dist/pages/fresh/' + rel, import.meta.url));
          if (rel === 'config.js') body = Buffer.from(body.toString().replace(/"singleNotebook":\{[^}]+\}/, '"singleNotebook":' + JSON.stringify({ id: active.clubId, name: '教练，我想打网球' })));
          const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
          await route.fulfill({ status: 200, contentType: types[path.extname(rel)] || 'text/plain', body });
          return;
        }
        assert.equal(url.origin, apiOrigin, 'test cannot contact external services');
        assert(url.pathname.startsWith(prefix + '/api/'), 'unexpected backend path');
        const response = await serve(new Request(apiOrigin + url.pathname.slice(prefix.length) + url.search,
          { method: req.method(), headers: await req.allHeaders(), body: req.postDataBuffer() || undefined }));
        if (response.status >= 400) apiFailures.push({ path: url.pathname, status: response.status });
        await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
      } catch (error) {
        report.diagnostics.push({ kind: 'route', message: error.message });
        await route.abort();
      }
    });
    return context;
  }
  const context = await contextFor(savedA.accountToken);
  page = await context.newPage();
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.setDefaultTimeout(10000);

  stage = 'remembered identity opens the only notebook';
  await page.goto(pageBase, { waitUntil: 'domcontentloaded' });
  await page.locator('.shell').waitFor();
  check('remembered member opens primary without notebook picker', page.url().endsWith('#c=' + active.clubId));
  check('primary name is preserved', await page.locator('.page-heading h1').textContent() === '教练，我想打网球');
  check('creation module removed', await noCreate());
  check('old brand is removed', !(await page.locator('.brand strong').allTextContents()).includes('网球搭子'));
  check('daily feed excludes archived notebook', !(await page.locator('body').innerText()).includes('甲已归档的训练'));
  await page.locator('.mobile-nav [data-tab="my"]').click();
  await wishValue(22500);
  await page.locator('[data-wishes-panel]').getByText('甲的私密球拍', { exact: true }).waitFor();
  check('own wishes retain archived historical duration');
  check('mobile has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: path.join(artifacts, 'single-notebook-mobile.png'), fullPage: true });
  await page.locator('[data-action="home"]:visible').first().click();
  await page.locator('.page-heading h1').getByText('教练，我想打网球', { exact: true }).waitFor();
  check('notebook home returns directly to primary feed');

  stage = 'logout removes private content';
  await logout();
  check('logout clears private board and wishes', !await page.locator('.shell, [data-wishes-panel], [data-wishes-teaser]').count());
  check('anonymous home has recovery and invitation guidance', /恢复码/.test(await page.locator('.notebook-access').innerText()) && /完整邀请链接/.test(await page.locator('.notebook-access').innerText()));
  check('anonymous home has no create module', await noCreate());
  await page.setViewportSize({ width: 320, height: 740 });
  check('narrow anonymous home has no overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: path.join(artifacts, 'notebook-login-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });

  stage = 'archived-only account remains private and needs invitation';
  await recoveryLogin(savedB.recoveryCode);
  await page.locator('.notebook-access').getByText('让群友带你入场', { exact: true }).waitFor();
  await wishValue(30000);
  check('archived-only account sees own wishes', (await page.locator('[data-wishes-panel]').innerText()).includes('乙的私密旅行'));
  check('switching account does not reveal previous wishes', !(await page.locator('body').innerText()).includes('甲的私密球拍'));
  check('recovery cannot silently join primary', f.sqlite.prepare('SELECT COUNT(*) AS total FROM members WHERE account_id=? AND club_id=?').get(savedB.account.id, active.clubId).total === 0);
  await page.goto(pageBase + '#c=' + active.clubId, { waitUntil: 'domcontentloaded' });
  await page.locator('.notebook-access').getByText('让群友带你入场', { exact: true }).waitFor();
  check('direct primary URL still requires membership', !await page.locator('.shell').count());

  stage = 'archived and invalid routes stay safe';
  await page.goto(pageBase + '#c=' + archived.clubId, { waitUntil: 'domcontentloaded' });
  await page.locator('.notebook-access').getByText('继续使用这本记录本', { exact: true }).waitFor();
  check('archived explicit route exposes no board', !await page.locator('.shell, #join-form').count());
  await page.goto(pageBase + '#g=' + archived.invite, { waitUntil: 'domcontentloaded' });
  await page.locator('.error-panel').getByText(/已归档/).waitFor();
  check('archived invite explains archive without joining', !await page.locator('.shell, #join-form').count());
  await page.goto(pageBase + '#g=broken', { waitUntil: 'domcontentloaded' });
  await page.locator('#invalid-invite').waitFor();
  check('invalid invite remains invalid instead of auto-opening', !await page.locator('.shell').count());
  await page.goto(pageBase + '#p=' + publicCard.data.token, { waitUntil: 'domcontentloaded' });
  await page.locator('.public-card-page h1').getByText('球友甲', { exact: true }).waitFor();
  check('public card retains its route and has no private content', !await page.locator('.shell, [data-wishes-panel], [data-wishes-teaser]').count());

  stage = 'new friend joins primary via nickname and keeps identity';
  const newcomer = await contextFor();
  page = await newcomer.newPage();
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(pageBase + '#g=' + active.invite, { waitUntil: 'domcontentloaded' });
  await page.locator('.invite-gate [data-action="quick-signup"]').click();
  await page.locator('#quick-name').fill('球友丙');
  await page.locator('#quick-auth-form button[type="submit"]').click();
  await page.locator('#saved-recovery-code').waitFor();
  const code = await page.locator('#saved-recovery-code').inputValue();
  assert.match(code, /^TC-(?:[A-F0-9]{8}-){4}[A-F0-9]{8}$/);
  await page.locator('.recovery-card [data-action="close"]').click();
  await page.locator('#join-form button[type="submit"]').click();
  await page.locator('.shell').waitFor();
  check('nickname onboarding joins the existing notebook', (await page.locator('.identity-strip').innerText()).includes('球友丙'));
  check('onboarding creates no extra notebook', f.sqlite.prepare('SELECT COUNT(*) AS total FROM clubs').get().total === 2);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.shell').waitFor();
  check('new friend is remembered after reload', (await page.locator('.identity-strip').innerText()).includes('球友丙'));
  await logout();
  await recoveryLogin(code);
  await page.locator('.shell').waitFor();
  check('recovery reopens same member and notebook', f.sqlite.prepare('SELECT COUNT(*) AS total FROM members WHERE club_id=? AND nickname=?').get(active.clubId, '球友丙').total === 1 && (await page.locator('.identity-strip').innerText()).includes('球友丙'));
  await page.locator('.mobile-nav [data-tab="my"]').click();
  await wishValue(0);
  check('new friend receives an independent empty wish account', !(await page.locator('[data-wishes-panel]').innerText()).includes('甲的私密球拍'));
  check('no runtime errors', runtimeErrors.length === 0);
  check('only expected permission/archive responses occurred', apiFailures.every(item => [403, 410].includes(item.status)));
  check('all network calls stayed within intercepted fixtures', report.diagnostics.length === 0);
  report.passed = true;
} catch (error) {
  report.failedStage = stage;
  report.error = error.message;
  if (page) {
    try { await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }); } catch {}
    try { report.visibleErrors = await page.locator('.form-error, .error-panel').allTextContents(); } catch {}
    try { report.visibleHeading = await page.locator('.page-heading h1').allTextContents(); } catch {}
  }
} finally {
  report.diagnostics.push(...runtimeErrors.map(message => ({ kind: 'runtime', message })));
  if (browser) await browser.close();
  for (const fn of cleanup.reverse()) await fn();
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
if (!report.passed) process.exitCode = 1;
