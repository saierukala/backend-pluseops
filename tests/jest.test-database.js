import { testDatabaseUrl } from './helpers/test-database.js';

// Runs before each suite's modules load, so src/config/env.js sees the test database.
process.env.DATABASE_URL = testDatabaseUrl();
