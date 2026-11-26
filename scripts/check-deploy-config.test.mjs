import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateDeployConfig} from './check-deploy-config.mjs';

const config = {
  VERCEL_TOKEN: 'test-only-token', VERCEL_ORG_ID: 'test-team',
  VERCEL_BACKEND_PROJECT_ID: 'test-backend', VERCEL_FRONTEND_PROJECT_ID: 'test-frontend',
  SUPABASE_MIGRATION_URL: 'postgresql://postgres.test:test-only-password@aws-0-example.pooler.supabase.com:5432/postgres',
};

test('accepts Supabase session/direct connections', () => {
  assert.doesNotThrow(() => validateDeployConfig(config));
  assert.doesNotThrow(() => validateDeployConfig({...config,
    SUPABASE_MIGRATION_URL: 'postgresql://postgres:test-password@db.example.supabase.co:5432/postgres?sslmode=require'}));
});
test('reports missing secret names without their values', () => {
  assert.throws(() => validateDeployConfig({...config, VERCEL_TOKEN: ''}), /VERCEL_TOKEN/);
});
test('rejects localhost and lookalike domains', () => {
  for (const host of ['127.0.0.1', 'localhost', 'db.supabase.co.evil.example']) {
    assert.throws(() => validateDeployConfig({...config,
      SUPABASE_MIGRATION_URL: `postgresql://test:test-password@${host}:5432/postgres`}), /prototype Supabase/);
  }
});
test('rejects transaction pooling and explicitly disabled SSL', () => {
  assert.throws(() => validateDeployConfig({...config,
    SUPABASE_MIGRATION_URL: config.SUPABASE_MIGRATION_URL.replace(':5432/', ':6543/')}), /direct\/session/);
  assert.throws(() => validateDeployConfig({...config,
    SUPABASE_MIGRATION_URL: config.SUPABASE_MIGRATION_URL+'?pgbouncer=true'}), /direct\/session/);
  assert.throws(() => validateDeployConfig({...config,
    SUPABASE_MIGRATION_URL: config.SUPABASE_MIGRATION_URL+'?sslmode=disable'}), /SSL/);
});
test('rejects identical projects and redacts invalid connection input', () => {
  assert.throws(() => validateDeployConfig({...config,
    VERCEL_FRONTEND_PROJECT_ID: config.VERCEL_BACKEND_PROJECT_ID}), /different Vercel/);
  const bad='not-a-url-with-secret-value';
  assert.throws(() => validateDeployConfig({...config, SUPABASE_MIGRATION_URL: bad}),
    error => error instanceof Error && !error.message.includes(bad));
});
