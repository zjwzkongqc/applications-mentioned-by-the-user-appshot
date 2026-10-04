import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist/pages');
const config = {
  apiBaseUrl: 'https://tennis-dazi-club-2026.divine-seal-5110.chatgpt.site',
  pageBaseUrl: 'https://zjwzkongqc.github.io/applications-mentioned-by-the-user-appshot/'
};

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
