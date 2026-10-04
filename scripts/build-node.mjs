import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = [['HTML', 'index.html'], ['CSS', 'style.css'], ['JS', 'app.js'], ['HEX_JS', 'hexagon.js'], ['GROWTH_JS', 'growth.js']];
const declarations = await Promise.all(assets.map(async ([name, file]) => `const ${name}=${JSON.stringify(await fs.readFile(path.join(root, 'src', file), 'utf8'))};`));
const source = await fs.readFile(path.join(root, 'src/worker.js'), 'utf8');
if (source.split('/*__ASSETS__*/').length !== 2) throw new Error('The shared worker must contain exactly one asset placeholder.');
const output = path.join(root, 'dist/node');
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, 'worker.mjs'), source.replace('/*__ASSETS__*/', declarations.join('\n')));
console.log('Built standalone Node backend with the shared API and application assets.');
