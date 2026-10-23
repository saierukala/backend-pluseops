import { execSync } from 'node:child_process';
import { testDatabaseUrl } from './helpers/test-database.js';

// Creates (if needed) and migrates the test database once per Jest run. `migrate deploy` creates a missing
// PostgreSQL database and only applies committed migrations, like CI.
export default async function globalSetup() {
  const url = testDatabaseUrl();
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
}
