import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const required = [
  'VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_BACKEND_PROJECT_ID',
  'VERCEL_FRONTEND_PROJECT_ID', 'SUPABASE_MIGRATION_URL',
];

export function validateDeployConfig(env) {
  const missing = required.filter(name => !env[name]?.trim());
  if (missing.length) {
    throw new Error(`Configure GitHub Actions repository secrets: ${missing.join(', ')}. See docs/CI-CD.md.`);
  }
  if (env.VERCEL_BACKEND_PROJECT_ID.trim() === env.VERCEL_FRONTEND_PROJECT_ID.trim()) {
    throw new Error('Backend and frontend must use different Vercel Project IDs.');
  }
  let url;
  try {
    url = new URL(env.SUPABASE_MIGRATION_URL);
  } catch {
    throw new Error('SUPABASE_MIGRATION_URL must be a PostgreSQL connection URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.password) {
    throw new Error('SUPABASE_MIGRATION_URL must include PostgreSQL credentials.');
  }
  const host = url.hostname.toLowerCase();
  if (!host.endsWith('.supabase.co') && !host.endsWith('.pooler.supabase.com')) {
    throw new Error('SUPABASE_MIGRATION_URL must target the prototype Supabase project, not a local or unrelated database.');
  }
  if ((url.port && url.port !== '5432') || url.searchParams.get('pgbouncer') === 'true') {
    throw new Error('Use a direct/session connection on port 5432 for migrations, not the transaction pooler.');
  }
  if (url.searchParams.get('sslmode') === 'disable') {
    throw new Error('Do not disable SSL on the production migration connection.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    validateDeployConfig(process.env);
    console.log('Production configuration is present; migration target passed structural validation.');
  } catch (error) {
    // Never include connection strings or token values in logs.
    console.error(error.message);
    process.exitCode = 1;
  }
}
