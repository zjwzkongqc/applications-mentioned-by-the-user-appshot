import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const wrapperFile = fileURLToPath(new URL('./migration-export-worker.mjs', import.meta.url));

// Explicit opt-in only: npm run build, build:pages, and build:node never use this.
export async function buildMigrationExport({ projectRoot = defaultRoot, outputDir = path.join(projectRoot, 'dist/server') } = {}) {
  const [worker, html, css, js, hexJs, growthJs, wrapper, configText] = await Promise.all([
    fs.readFile(path.join(projectRoot, 'src/worker.js'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'src/index.html'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'src/style.css'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'src/app.js'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'src/hexagon.js'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'src/growth.js'), 'utf8'),
    fs.readFile(wrapperFile, 'utf8'),
    fs.readFile(path.join(projectRoot, 'wrangler.json'), 'utf8')
  ]);
  if ((worker.match(/\/\*__ASSETS__\*\//g) || []).length !== 1 || (worker.match(/\bexport\s+default\b/g) || []).length !== 1 ||
      worker.includes('tennisMigrationOriginalHandler') || /^import\s/m.test(wrapper)) throw new Error('The original Worker cannot be safely wrapped.');
  const assets = `const HTML=${JSON.stringify(html)};const CSS=${JSON.stringify(css)};const JS=${JSON.stringify(js)};const HEX_JS=${JSON.stringify(hexJs)};const GROWTH_JS=${JSON.stringify(growthJs)};`;
  const original = worker.replace(/\bexport\s+default\b/, 'const tennisMigrationOriginalHandler =').replace('/*__ASSETS__*/', assets);
  const inlineWrapper = wrapper.replace(/^export\s+/gm, '');
  const compiled = `${original}\nconst tennisMigrationWrapper = (() => {\n${inlineWrapper}\nreturn wrapMigrationExport;\n})();\nexport default tennisMigrationWrapper(tennisMigrationOriginalHandler);\n`;
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'index.js'), compiled);
  await fs.writeFile(path.join(outputDir, 'wrangler.json'), JSON.stringify({ ...JSON.parse(configText), main: 'index.js' }, null, 2) + '\n');
  return outputDir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildMigrationExport().then(() => console.log('Built temporary maintenance/export Worker. No data or admin credential was read.'))
    .catch(() => { console.error('Temporary maintenance/export Worker build failed.'); process.exitCode = 1; });
}
