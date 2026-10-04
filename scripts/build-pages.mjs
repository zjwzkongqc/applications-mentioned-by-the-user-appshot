import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const LEGACY_API_ORIGIN = 'https://tennis-dazi-club-2026.divine-seal-5110.chatgpt.site';
export const PAGES_BASE_URL = 'https://zjwzkongqc.github.io/applications-mentioned-by-the-user-appshot/';
export const APP_ID = 'tennis-dazi-club-2026';

// Only a public HTTPS origin belongs in the shipped config and connect-src.
// Reject URL components rather than silently dropping credentials or paths.
export function validateApiOrigin(value) {
  if (typeof value !== 'string' || value !== value.trim() || !/^https:\/\//.test(value)) {
    throw new Error('TENNIS_API_BASE_URL must be a complete public HTTPS origin.');
  }
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid API origin.'); }
  const host = url.hostname;
  if (url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/' ||
      !/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)+$/.test(host) ||
      host.length > 253 || host.split('.').some(label => label.length > 63) ||
      /^\d+(?:\.\d+){3}$/.test(host) || /\.(?:localhost|local|internal|test|invalid|example)$/.test(host) ||
      /(?:^|\.)example\.(?:com|net|org)$/.test(host) || /[\\\s]/.test(value) ||
      (value !== url.origin && value !== url.origin + '/')) {
    throw new Error('API base must contain only a public HTTPS hostname, with no credentials, port, path, query or fragment.');
  }
  return url.origin;
}

export function getPagesConfig(env = process.env) {
  const explicitApi = env.TENNIS_API_BASE_URL !== undefined;
  const apiBaseUrl = explicitApi ? validateApiOrigin(env.TENNIS_API_BASE_URL) : LEGACY_API_ORIGIN;
  if (explicitApi && /(?:^|\.)chatgpt\.site$/.test(new URL(apiBaseUrl).hostname)) {
    throw new Error('The replacement API must use its new HTTPS hostname, outside chatgpt.site.');
  }
  const config = { apiBaseUrl, pageBaseUrl: PAGES_BASE_URL };
  const from = env.TENNIS_MIGRATION_FROM_ORIGIN, migrationId = env.TENNIS_MIGRATION_ID;
  if (from !== undefined || migrationId !== undefined) {
    if (!explicitApi || validateApiOrigin(from) !== LEGACY_API_ORIGIN || !/^[a-f0-9]{64}$/.test(migrationId || '')) {
      throw new Error('Credential migration requires the explicit new API origin, the trusted legacy origin, and a 64-character lowercase hex migration ID.');
    }
    config.credentialMigration = { appId: APP_ID, schemaVersion: 4, fromApiOrigin: LEGACY_API_ORIGIN, migrationId };
  }
  return config;
}

export async function buildPages({ output = path.join(root, 'dist/pages'), env = process.env } = {}) {
  const config = getPagesConfig(env);

  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });

  let html = await fs.readFile(path.join(root, 'src/index.html'), 'utf8');
  html = html.replace(/\b(href|src)="\/([^"]*)"/g, '$1="./$2"');
  html = html.replace('<meta charset="UTF-8">', '<meta charset="UTF-8">\n  <meta name="referrer" content="no-referrer">\n  <meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\'; connect-src \'self\' '+config.apiBaseUrl+'; img-src \'self\' blob: data:; object-src \'none\'; base-uri \'self\'; form-action \'self\'">');
  if (!/<script\b[^>]*\bsrc=["'](?:\.\/)?config\.js["']/.test(html)) {
    html = html.replace(/<script\b/, '<script src="./config.js" defer></script>\n  <script');
  }
  if (!html.includes('src="./config.js"')) {
    throw new Error('The Pages HTML must load config.js before the application scripts.');
  }
  await fs.writeFile(path.join(output, 'config.js'), `window.TENNIS_CONFIG = Object.freeze(${JSON.stringify(config, null, 2)});\n`);

  await Promise.all(['style.css', 'app.js', 'hexagon.js', 'growth.js'].map(file =>
    fs.copyFile(path.join(root, 'src', file), path.join(output, file))
  ));
  for (const file of ['config.js', 'style.css', 'app.js', 'hexagon.js', 'growth.js']) {
    const version = createHash('sha256').update(await fs.readFile(path.join(output, file))).digest('hex').slice(0, 12);
    html = html.replaceAll(`"./${file}"`, `"./${file}?v=${version}"`);
  }
  await fs.writeFile(path.join(output, 'index.html'), html);
  await fs.writeFile(path.join(output, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="12" fill="#143d2e"/><circle cx="20" cy="20" r="12" fill="#d5f566"/><path d="M12 10c10 5 10 15 0 20M28 10c-10 5-10 15 0 20" fill="none" stroke="#143d2e" stroke-width="2"/></svg>\n');
  await fs.writeFile(path.join(output, '.nojekyll'), '');
  console.log(`Built GitHub Pages application: ${config.pageBaseUrl}`);
  return { config, output };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildPages();
