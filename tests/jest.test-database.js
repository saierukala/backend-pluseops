import { testDatabaseUrl } from './helpers/test-database.js';

// Runs before each suite's modules load, so src/config/env.js sees the test database.
process.env.DATABASE_URL = testDatabaseUrl();

// Phase 37: suites written before GST assume tax-free order totals; GST tests opt in per workspace
// (gstRatePercent) instead of relying on the 18% production default.
process.env.DEFAULT_GST_RATE_PERCENT ??= '0';
