import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const validateOnly = process.argv.slice(2).includes('--validate-only');
if (process.argv.slice(2).some(arg => arg !== '--validate-only')) {
  console.error('Usage: node scripts/configure-cloudflare.mjs [--validate-only]');
  process.exit(1);
}

function variable(name, pattern, fallback) {
  const value = (process.env[name] || fallback || '').trim();
  if (!value || !pattern.test(value)) {
    throw new Error(`Repository variable ${name} is missing or has an invalid format.`);
  }
  return value;
}

try {
  const accountId = variable('CF_ACCOUNT_ID', /^[a-f0-9]{32}$/i);
  const databaseId = variable('CF_D1_DATABASE_ID', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  if (/^0+$/.test(accountId) || /^0+$/.test(databaseId.replaceAll('-', ''))) {
    throw new Error('Cloudflare account and database identifiers must identify real resources.');
  }
  const bucketName = variable('CF_R2_BUCKET_NAME', /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
  const databaseName = variable('CF_D1_DATABASE_NAME', /^[a-z][a-z0-9_-]{0,62}$/, 'tennis-club');
  const workerName = variable('CF_WORKER_NAME', /^[a-z][a-z0-9-]{0,62}$/, 'tennis-club');
  const template = JSON.parse(await fs.readFile(path.join(root, 'wrangler.json'), 'utf8'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(template.compatibility_date || '')) {
    throw new Error('wrangler.json must specify a compatibility_date.');
  }
  if (validateOnly) {
    console.log('Cloudflare deployment variables are valid.');
    process.exit(0);
  }
  await fs.access(path.join(root, 'dist/server/index.js'));
  const production = {
    name: workerName,
    main: 'dist/server/index.js',
    compatibility_date: template.compatibility_date,
    ...(template.compatibility_flags ? { compatibility_flags: template.compatibility_flags } : {}),
    account_id: accountId,
    workers_dev: true,
    d1_databases: [{ binding: 'DB', database_name: databaseName, database_id: databaseId, migrations_dir: 'drizzle' }],
    r2_buckets: [{ binding: 'BUCKET', bucket_name: bucketName }]
  };
  const compiled = {
    ...production,
    main: 'index.js',
    d1_databases: production.d1_databases.map(database => ({ ...database, migrations_dir: '../../drizzle' }))
  };
  await fs.writeFile(path.join(root, 'wrangler.production.json'), JSON.stringify(production, null, 2) + '\n');
  await fs.writeFile(path.join(root, 'dist/server/wrangler.production.json'), JSON.stringify(compiled, null, 2) + '\n');
  console.log('Production Cloudflare configuration generated.');
} catch (error) {
  console.error(`Deployment configuration failed: ${error.message}`);
  process.exitCode = 1;
}
