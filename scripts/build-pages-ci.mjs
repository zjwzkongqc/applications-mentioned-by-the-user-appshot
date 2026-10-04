import { buildPages } from './build-pages.mjs';

// GitHub maps an unset repository variable to an empty environment value.
// Preserve the deployed configuration until the owner supplies a new origin.
for (const name of ['TENNIS_API_BASE_URL', 'TENNIS_MIGRATION_FROM_ORIGIN', 'TENNIS_MIGRATION_ID']) {
  if (process.env[name] === '') delete process.env[name];
}
await buildPages();
