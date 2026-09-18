/**
 * Global test teardown for Jest — ensures BullMQ/Redis/Prisma handles do not leak
 * between suites when running `npm test` with --runInBand (single process).
 * Do NOT use --forceExit to hide leaks; close deterministically.
 */
import { disconnectBullMqRedis } from '../src/jobs/connection.js';
import { disconnectDatabase } from '../src/config/database.js';
import { disconnectRedis } from '../src/config/redis.js';
import { closeAllQueues } from '../src/jobs/queues/index.js';
import { stopWorkers } from '../src/jobs/workers/index.js';
import { stopMetricsInterval } from '../src/config/metrics.js';

// This afterAll runs once after ALL test suites in the same Jest process (runInBand)
// It supplements per-suite afterAll hooks that already call disconnectDatabase.
afterAll(async () => {
  // Give in-flight jobs a moment to settle before tearing down
  await new Promise((r) => setTimeout(r, 200));
  try {
    await stopWorkers();
  } catch (_e) { void _e; }
  try {
    await closeAllQueues();
  } catch (_e) { void _e; }
  try {
    await disconnectBullMqRedis();
  } catch (_e) { void _e; }
  try {
    await disconnectRedis();
  } catch (_e) { void _e; }
  try {
    await disconnectDatabase();
  } catch (_e) { void _e; }
  try {
    stopMetricsInterval();
  } catch (_e) { void _e; }
  // Allow logger to flush and ensure any remaining timers/sockets are cleared
  await new Promise((r) => setTimeout(r, 300));
  // Force GC of any remaining handles by clearing interval refs
  if (global.gc) global.gc();
});
