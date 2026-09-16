import http from 'node:http';
import { createApp } from './app.js';
import { env } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { connectRedis, disconnectRedis } from '../config/redis.js';
import { logger } from '../config/logger.js';

const app = createApp();
const server = http.createServer(app);
let ioInstance = null;
let shuttingDown = false;

async function initSocketIO() {
  const { createSocketServer } = await import('../realtime/socket.server.js');
  ioInstance = createSocketServer(server);
  return ioInstance;
}

export { server, ioInstance, initSocketIO };

async function start() {
  const dependencies = [
    { name: 'PostgreSQL', connect: connectDatabase },
    { name: 'Redis', connect: connectRedis }
  ];
  const results = await Promise.allSettled(dependencies.map(({ connect }) => connect()));
  const failures = results
    .map((result, index) => ({ result, name: dependencies[index].name }))
    .filter(({ result }) => result.status === 'rejected');

  if (failures.length > 0 && env.failOnDependencyError) {
    throw new AggregateError(failures.map(({ result }) => result.reason), 'Required dependencies are unavailable');
  }

  if (failures.length > 0) {
    logger.warn({ dependencies: failures.map(({ name }) => name) }, 'Starting with unavailable dependencies; readiness checks will remain down');
  }

  const dependencyStatus = results.map((result, index) => ({
    name: dependencies[index].name,
    ready: result.status === 'fulfilled' && result.value === true
  }));

  await initSocketIO();

  server.listen(env.PORT, env.HOST, () => {
    logger.info({ port: env.PORT, host: env.HOST }, 'PulseOps API listening');

    if (env.NODE_ENV !== 'production') {
      const serviceUrl = `http://localhost:${env.PORT}`;
      process.stdout.write(`${[
        '',
        'PulseOps API is running',
        `  API:    ${serviceUrl}/api/v1`,
        `  Health: ${serviceUrl}/health`,
        ...dependencyStatus.map(({ name, ready }) => `  ${name}: ${ready ? 'connected' : 'unavailable (readiness: 503)'}`),
        ''
      ].join('\n')}\n`);
    }
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Graceful shutdown started');
  if (ioInstance) {
    try {
      const { closeSocketServer } = await import('../realtime/socket.server.js');
      closeSocketServer(ioInstance);
    } catch (_e) { void _e; }
  }
  server.close(async () => {
    await Promise.all([disconnectRedis(), disconnectDatabase()]);
    logger.info('Graceful shutdown complete');
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled rejection');
  shutdown('unhandledRejection');
});

start().catch((error) => {
  logger.fatal({ err: error }, 'Unable to start PulseOps API');
  process.exit(1);
});
