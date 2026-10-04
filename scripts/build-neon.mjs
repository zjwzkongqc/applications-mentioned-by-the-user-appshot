import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import { build } from 'esbuild';
import { zipSync } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'dist/neon/index.mjs');
await import('./build-node.mjs');
const bundled = await build({ absWorkingDir: root, entryPoints: [path.join(root, 'neon/functions/tennis-api/index.mjs')],
  outfile: destination, bundle: true, format: 'esm', platform: 'node', target: 'node24', write: false, metafile: true,
  sourcemap: false, legalComments: 'none',
  // The SDK includes CommonJS helpers. Neon's documented deployment banner
  // restores Node's require/file globals while preserving an ESM default.
  banner: { js: "import{createRequire as ___cr}from'node:module';import{fileURLToPath as ___f}from'node:url';import{dirname as ___d}from'node:path';const require=___cr(import.meta.url);const __filename=___f(import.meta.url);const __dirname=___d(__filename);" } });
const builtins = new Set(builtinModules.flatMap(name => [name, 'node:' + name]));
for (const output of Object.values(bundled.metafile.outputs)) for (const dependency of output.imports) {
  if (dependency.external && !builtins.has(dependency.path)) throw new Error('The Neon bundle contains an unexpected runtime dependency.');
}
if (bundled.outputFiles.length !== 1) throw new Error('The Neon deployment requires one complete module.');
await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.writeFile(destination, bundled.outputFiles[0].contents);
await fs.writeFile(path.join(root, 'dist/neon/function.zip'), zipSync({ 'index.mjs': bundled.outputFiles[0].contents }, { level: 9 }));
console.log('Built the complete Neon Node24 module and deployment ZIP.');
