import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = [['HTML', 'index.html'], ['CSS', 'style.css'], ['JS', 'app.js'], ['HEX_JS', 'hexagon.js'], ['GROWTH_JS', 'growth.js'], ['CLUB_JS', 'club-ui.js']];
const contents = new Map(await Promise.all(assets.map(async ([name, file]) => [name, await fs.readFile(path.join(root, 'src', file), 'utf8')])));
// This complete server serves its own frontend. Do not send invitations or
// account recovery back to the previous GitHub/ChatGPT entrypoints.
contents.set('JS', 'window.TENNIS_CONFIG={sameOriginOnly:true};\n' + contents.get('JS'));
let html = contents.get('HTML');
for (const [name, file] of assets.filter(([name]) => name !== 'HTML')) {
  const version = createHash('sha256').update(contents.get(name)).digest('hex').slice(0, 12);
  html = html.replaceAll(`"/${file}"`, `"/${file}?v=${version}"`);
}
contents.set('HTML', html);
const declarations = [...contents].map(([name, value]) => `const ${name}=${JSON.stringify(value)};`);
const source = await fs.readFile(path.join(root, 'src/worker.js'), 'utf8');
if (source.split('/*__ASSETS__*/').length !== 2) throw new Error('The shared worker must contain exactly one asset placeholder.');
const output = path.join(root, 'dist/node');
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, 'worker.mjs'), source.replace('/*__ASSETS__*/', declarations.join('\n')));
console.log('Built standalone Node backend with the shared API and application assets.');
