/**
 * Phase 34: Jest never runs against the development database. The test URL is TEST_DATABASE_URL, or
 * DATABASE_URL with `_test` appended to the database name (pulseops → pulseops_test).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnvFile() {
  const file = resolve(process.cwd(), '.env');
  if (!existsSync(file) || typeof process.loadEnvFile !== 'function') return;
  const deployment = { ...process.env };
  process.loadEnvFile(file);
  Object.assign(process.env, deployment);
}

export function testDatabaseUrl() {
  loadEnvFile();
  const raw = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!raw) throw new Error('Set DATABASE_URL or TEST_DATABASE_URL to run the tests');
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = `/${name}_test`;
  return url.toString();
}
