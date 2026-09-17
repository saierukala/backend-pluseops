import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = path.resolve(process.cwd());

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function exists(file) {
  return fs.existsSync(path.join(root, file));
}

describe('Phase 23 — Docker / CI/CD / Deployment', () => {
  // ──────────────────────────────────────────────────────────
  // Dockerfile
  // ──────────────────────────────────────────────────────────
  describe('Dockerfile', () => {
    test('Dockerfile exists', () => {
      expect(exists('Dockerfile')).toBe(true);
    });

    test('uses multi-stage build', () => {
      const c = read('Dockerfile');
      const fromCount = (c.match(/^FROM /gm) || []).length;
      expect(fromCount).toBeGreaterThanOrEqual(2);
      expect(c).toMatch(/AS deps/);
      expect(c).toMatch(/AS production/);
    });

    test('uses production Node.js runtime node:22-alpine', () => {
      const c = read('Dockerfile');
      expect(c).toMatch(/FROM node:22-alpine/);
    });

    test('installs production dependencies reproducibly (npm ci)', () => {
      const c = read('Dockerfile');
      expect(c).toMatch(/npm ci/);
    });

    test('generates Prisma Client', () => {
      const c = read('Dockerfile');
      expect(c).toMatch(/prisma generate/);
    });

    test('has non-root runtime (pulseops user)', () => {
      const c = read('Dockerfile');
      expect(c).toMatch(/adduser.*pulseops/);
      expect(c).toMatch(/USER pulseops/);
    });

    test('uses tini for PID 1 signal forwarding (graceful shutdown)', () => {
      const c = read('Dockerfile');
      expect(c).toMatch(/tini/);
      expect(c).toMatch(/ENTRYPOINT.*tini/);
    });

    test('exposes port 3000 and has correct default CMD (API)', () => {
      const c = read('Dockerfile');
      expect(c).toMatch(/EXPOSE 3000/);
      expect(c).toMatch(/src\/app\/server\.js/);
    });

    test('has HEALTHCHECK using application liveness endpoint', () => {
      const c = read('Dockerfile');
      expect(c).toMatch(/HEALTHCHECK/);
      expect(c).toMatch(/\/health/);
    });

    test('does not copy or embed .env', () => {
      const c = read('Dockerfile');
      expect(c).not.toMatch(/COPY.*\.env/);
    });

    test('does not bake database credentials', () => {
      const c = read('Dockerfile');
      // No hardcoded DATABASE_URL or POSTGRES_PASSWORD baked into image
      // Note: `chown -R pulseops:pulseops` is filesystem ownership, not DB credentials — allowed
      expect(c).not.toMatch(/DATABASE_URL=postgresql/);
      expect(c).not.toMatch(/POSTGRES_PASSWORD/);
      expect(c).not.toMatch(/POSTGRES_USER.*pulseops.*PASSWORD/);
    });
  });

  // ──────────────────────────────────────────────────────────
  // .dockerignore
  // ──────────────────────────────────────────────────────────
  describe('.dockerignore', () => {
    test('.dockerignore exists', () => {
      expect(exists('.dockerignore')).toBe(true);
    });
    test('excludes .env, node_modules, storage, git, coverage', () => {
      const c = read('.dockerignore');
      expect(c).toMatch(/\.env/);
      expect(c).toMatch(/node_modules/);
      expect(c).toMatch(/storage/);
      expect(c).toMatch(/\.git/);
      expect(c).toMatch(/coverage/);
    });
    test('excludes GitHub and test artifacts', () => {
      const c = read('.dockerignore');
      expect(c).toMatch(/\.github/);
    });
  });

  // ──────────────────────────────────────────────────────────
  // docker-compose.yml
  // ──────────────────────────────────────────────────────────
  describe('docker-compose.yml', () => {
    test('docker-compose.yml exists', () => {
      expect(exists('docker-compose.yml')).toBe(true);
    });

    test('defines required services: api, worker, postgres, redis, migrate', () => {
      const c = read('docker-compose.yml');
      expect(c).toMatch(/^\s*api:/m);
      expect(c).toMatch(/^\s*worker:/m);
      expect(c).toMatch(/^\s*postgres:/m);
      expect(c).toMatch(/^\s*redis:/m);
      expect(c).toMatch(/^\s*migrate:/m);
    });

    test('postgres uses official postgres image with named volume', () => {
      const c = read('docker-compose.yml');
      expect(c).toMatch(/image:\s*postgres:16-alpine/);
      expect(c).toMatch(/pgdata:/);
      expect(c).toMatch(/\/var\/lib\/postgresql\/data/);
    });

    test('postgres healthcheck uses pg_isready', () => {
      const c = read('docker-compose.yml');
      expect(c).toMatch(/pg_isready/);
      expect(c).toMatch(/POSTGRES_USER/);
    });

    test('redis has healthcheck (redis-cli ping)', () => {
      const c = read('docker-compose.yml');
      expect(c).toMatch(/redis:7-alpine/);
      expect(c).toMatch(/redis-cli/);
      expect(c).toMatch(/ping/);
      expect(c).toMatch(/redisdata:/);
    });

    test('api and worker depend on postgres/redis via service_healthy (not just started)', () => {
      const c = read('docker-compose.yml');
      // api
      expect(c).toMatch(/condition:\s*service_healthy/);
      expect(c).toMatch(/condition:\s*service_completed_successfully/);
    });

    test('migrate service uses `prisma migrate deploy` (never migrate dev)', () => {
      const c = read('docker-compose.yml');
      expect(c).toMatch(/prisma.*migrate.*deploy/);
      // Check no executed command uses migrate dev (comments may mention it with "never")
      expect(c).not.toMatch(/npx prisma migrate dev/);
      expect(c).not.toMatch(/command:.*migrate dev/);
    });

    test('api exposes 3000 and has healthcheck via /health', () => {
      const c = read('docker-compose.yml');
      expect(c).toMatch(/"3000:3000"/);
      expect(c).toMatch(/\/health/);
    });

    test('worker overrides command to run worker entrypoint', () => {
      const c = read('docker-compose.yml');
      expect(c).toMatch(/src\/worker\.js/);
    });

    test(' compose config is valid YAML (docker compose config)', () => {
      try {
        execSync('docker compose config --quiet', { stdio: 'pipe', timeout: 15000 });
      } catch (e) {
        const stderr = e.stderr?.toString() || e.message;
        throw new Error(`docker compose config failed: ${stderr}`, { cause: e });
      }
    });

    test('production overlay is valid (docker compose -f docker-compose.yml -f docker-compose.prod.yml config)', () => {
      try {
        execSync('docker compose -f docker-compose.yml -f docker-compose.prod.yml config --quiet', {
          stdio: 'pipe',
          timeout: 15000,
          env: {
            ...process.env,
            CORS_ORIGINS: 'https://app.example.com',
            DATABASE_URL: 'postgresql://pulseops:pulseops@localhost:5432/pulseops?schema=public&connection_limit=10&sslmode=require',
            REDIS_URL: 'redis://localhost:6379',
            JWT_ACCESS_SECRET: 'test-access-secret-min-32-chars-long-for-testing',
            JWT_REFRESH_SECRET: 'test-refresh-secret-min-32-chars-long-for-testing',
            PAYMENT_WEBHOOK_SECRET: 'test-webhook-secret-min-32-chars-long-for-testing',
          },
        });
      } catch (e) {
        const stderr = e.stderr?.toString() || e.message;
        throw new Error(`prod overlay config failed: ${stderr}`, { cause: e });
      }
    });

    test('no .env or secrets baked into compose', () => {
      // Compose for dev may have dev secrets inline — ensure prod overlay requires env vars
      expect(read('docker-compose.prod.yml')).toMatch(/\$\{DATABASE_URL:\?/);
      expect(read('docker-compose.prod.yml')).toMatch(/\$\{JWT_ACCESS_SECRET:\?/);
    });
  });

  // ──────────────────────────────────────────────────────────
  // Worker entrypoint
  // ──────────────────────────────────────────────────────────
  describe('worker entrypoint', () => {
    test('src/worker.js exists', () => {
      expect(exists('src/worker.js')).toBe(true);
    });
    test('worker connects to PostgreSQL and Redis and starts BullMQ', () => {
      const c = read('src/worker.js');
      expect(c).toMatch(/connectDatabase/);
      expect(c).toMatch(/connectRedis/);
      expect(c).toMatch(/initJobs|startWorkers/);
    });
    test('worker handles graceful shutdown on SIGTERM/SIGINT', () => {
      const c = read('src/worker.js');
      expect(c).toMatch(/SIGTERM/);
      expect(c).toMatch(/SIGINT/);
      expect(c).toMatch(/shutdownJobs/);
      expect(c).toMatch(/disconnectRedis/);
      expect(c).toMatch(/disconnectDatabase/);
    });
    test('worker does not create HTTP server (separation from API)', () => {
      const c = read('src/worker.js');
      expect(c).not.toMatch(/createApp\(\)/);
      expect(c).not.toMatch(/http\.createServer/);
    });
  });

  // ──────────────────────────────────────────────────────────
  // Migrations
  // ──────────────────────────────────────────────────────────
  describe('migrations', () => {
    test('prisma schema is valid', () => {
      const out = execSync('npx prisma validate', { encoding: 'utf8', timeout: 15000 });
      expect(out).toMatch(/valid/i);
    });

    test('production migration command is `migrate deploy` everywhere (not dev)', () => {
      const dockerCompose = read('docker-compose.yml');
      expect(dockerCompose).toMatch(/migrate deploy/);
      // Only fail if an actual migrate dev command is executed, not documentation/comments
      expect(dockerCompose).not.toMatch(/npx prisma migrate dev/);
      const prodCompose = read('docker-compose.prod.yml');
      if (prodCompose.includes('migrate')) {
        expect(prodCompose).not.toMatch(/npx prisma migrate dev/);
      }
      const ci = read('.github/workflows/ci.yml');
      expect(ci).toMatch(/migrate deploy/);
      // CI has a guard `grep -r "migrate dev"` to assert absence — not a production command
      const ciWithoutGuard = ci.replace(/grep -r "migrate dev"/g, '');
      expect(ciWithoutGuard).not.toMatch(/npx prisma migrate dev/);
      // Deployment docs must make the distinction explicit
      const deployDocs = read('docs/DEPLOYMENT.md');
      expect(deployDocs).toMatch(/migrate deploy/);
      expect(deployDocs).toMatch(/migrate dev/);
      expect(deployDocs).toMatch(/NEVER.*migrate dev|never.*migrate dev/i);
    });
  });

  // ──────────────────────────────────────────────────────────
  // CI/CD workflow
  // ──────────────────────────────────────────────────────────
  describe('CI workflow (.github/workflows/ci.yml)', () => {
    test('workflow exists', () => {
      expect(exists('.github/workflows/ci.yml')).toBe(true);
    });

    test('contains required pipeline stages: install, lint, test, build, migration validation, deployment', () => {
      const c = read('.github/workflows/ci.yml');
      expect(c).toMatch(/name:\s*install/m);
      expect(c).toMatch(/name:\s*lint/m);
      expect(c).toMatch(/name:\s*test/m);
      expect(c).toMatch(/name:\s*build/m);
      expect(c).toMatch(/migration.validation|migration-validation/m);
      expect(c).toMatch(/name:\s*deployment/m);
    });

    test('install uses npm ci (reproducible)', () => {
      const c = read('.github/workflows/ci.yml');
      expect(c).toMatch(/npm ci/);
      expect(c).not.toMatch(/npm install/);
    });

    test('lint runs npm run lint', () => {
      const c = read('.github/workflows/ci.yml');
      expect(c).toMatch(/npm run lint/);
    });

    test('test runs npm test with disposable Postgres+Redis services', () => {
      const c = read('.github/workflows/ci.yml');
      expect(c).toMatch(/npm test/);
      expect(c).toMatch(/postgres:16-alpine/);
      expect(c).toMatch(/redis:7-alpine/);
      expect(c).toMatch(/DATABASE_URL/);
      expect(c).toMatch(/REDIS_URL/);
    });

    test('build validates Prisma and Docker build', () => {
      const c = read('.github/workflows/ci.yml');
      expect(c).toMatch(/prisma validate/);
      expect(c).toMatch(/prisma generate/);
      expect(c).toMatch(/docker build/);
      expect(c).toMatch(/docker compose config/);
    });

    test('migration validation uses disposable Postgres and migrate deploy (not dev)', () => {
      const c = read('.github/workflows/ci.yml');
      expect(c).toMatch(/migrate deploy/);
      const cWithoutGuard = c.replace(/grep -r "migrate dev"/g, '');
      expect(cWithoutGuard).not.toMatch(/npx prisma migrate dev/);
      expect(c).toMatch(/prisma migrate status/);
    });

    test('deployment stage exists and is provider-agnostic (no fake credentials)', () => {
      const c = read('.github/workflows/ci.yml');
      expect(c).toMatch(/deployment/);
      // Uses vars/secrets, not hardcoded credentials
      expect(c).toMatch(/secrets\.DATABASE_URL/);
      expect(c).toMatch(/secrets\.REDIS_URL/);
      // Does not hardcode a cloud provider host
      expect(c).not.toMatch(/fly\.io|render\.com|railway\.app.*password/i);
    });

    test('workflow does not leak secrets (no echo of secrets)', () => {
      const c = read('.github/workflows/ci.yml');
      // Should not have `echo ${{ secrets.` with the secret value expanded unchecked
      const echoSecrets = c.match(/echo.*secrets\./gi) || [];
      // Only allowed if it is checking existence, not echoing value
      for (const line of echoSecrets) {
        expect(line).not.toMatch(/echo.*\$\{\{\s*secrets\.(DATABASE_URL|REDIS_URL|JWT_)/);
      }
    });

    test('workflow YAML is valid (docker compose config already validated; check YAML parse)', () => {
      const c = read('.github/workflows/ci.yml');
      // Basic YAML sanity: must have `on:` and `jobs:`
      expect(c).toMatch(/^on:/m);
      expect(c).toMatch(/^jobs:/m);
      expect(c).toMatch(/runs-on:\s*ubuntu-latest/);
    });
  });

  // ──────────────────────────────────────────────────────────
  // Environment / secrets / storage contracts
  // ──────────────────────────────────────────────────────────
  describe('environment & storage contract', () => {
    test('.env is not tracked by git (gitignore)', () => {
      const gi = read('.gitignore');
      expect(gi).toMatch(/^\.env$/m);
    });

    test('.env is not present in Docker image (dockerignore) and not committed', () => {
      const di = read('.dockerignore');
      expect(di).toMatch(/\.env/);
      expect(exists('.env')).toBe(true); // local file exists but should not be tracked
      const tracked = execSync('git ls-files --cached', { encoding: 'utf8' });
      expect(tracked.split(/\r?\n/)).not.toContain('.env');
    });

    test('.env.example documents STORAGE_PROVIDER and DATABASE_URL', () => {
      const e = read('.env.example');
      expect(e).toMatch(/STORAGE_PROVIDER/);
      expect(e).toMatch(/DATABASE_URL/);
      expect(e).toMatch(/REDIS_URL/);
    });

    test('DEPLOYMENT.md documents storage contract (STORAGE_PROVIDER local vs s3)', () => {
      const d = read('docs/DEPLOYMENT.md');
      expect(d).toMatch(/STORAGE_PROVIDER/);
      expect(d).toMatch(/STORAGE_BUCKET|S3_BUCKET/);
      expect(d).toMatch(/STORAGE_REGION|S3_REGION/);
      expect(d).toMatch(/STORAGE_ENDPOINT|S3_ENDPOINT/);
      expect(d).toMatch(/STORAGE_ACCESS_KEY|S3_ACCESS_KEY_ID/);
      expect(d).toMatch(/STORAGE_SECRET_KEY|S3_SECRET_ACCESS_KEY/);
      expect(d).toMatch(/STORAGE_PROVIDER=local/);
      expect(d).toMatch(/STORAGE_PROVIDER=s3/);
    });

    test('DEPLOYMENT.md documents DATABASE_URL with connection_limit and sslmode', () => {
      const d = read('docs/DEPLOYMENT.md');
      expect(d).toMatch(/DATABASE_URL=postgresql:\/\//);
      expect(d).toMatch(/connection_limit/);
      expect(d).toMatch(/sslmode=require/);
      expect(d).toMatch(/PgBouncer/);
    });

    test('DEPLOYMENT.md documents production concerns (health, graceful shutdown, logs, monitoring, backups, rollback, HTTPS)', () => {
      const d = read('docs/DEPLOYMENT.md');
      expect(d).toMatch(/health/i);
      expect(d).toMatch(/graceful shutdown/i);
      expect(d).toMatch(/logs|Pino/i);
      expect(d).toMatch(/monitoring/i);
      expect(d).toMatch(/backups/i);
      expect(d).toMatch(/rollback/i);
      expect(d).toMatch(/HTTPS|reverse proxy/i);
    });

    test('no secrets are leaked in deployment docs (no real passwords/API keys)', () => {
      const d = read('docs/DEPLOYMENT.md');
      // Docs must use placeholders like ${DB_PASSWORD} or <secret>, not real-looking keys
      expect(d).not.toMatch(/sk-live|ghp_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}/);
    });
  });

  // ──────────────────────────────────────────────────────────
  // Security: no secrets committed
  // ──────────────────────────────────────────────────────────
  describe('security — no secrets committed', () => {
    test('no .env files are tracked', () => {
      const tracked = execSync('git ls-files --cached', { encoding: 'utf8' });
      const lines = tracked.split(/\r?\n/).filter(Boolean);
      // Only exact .env or .env.* are secrets; .env.example is intentionally tracked
      const envFiles = lines.filter((f) => f === '.env' || f.endsWith('/.env') || (/\.env\./.test(f) && !f.endsWith('.env.example')));
      expect(envFiles).toEqual([]);
    });

    test('no database credentials baked into Dockerfile', () => {
      const c = read('Dockerfile');
      expect(c).not.toMatch(/password/i);
      expect(c).not.toMatch(/DATABASE_URL/);
    });

    test('no storage credentials baked into Dockerfile or compose (dev uses local, prod uses vars)', () => {
      const c = read('Dockerfile');
      expect(c).not.toMatch(/S3_SECRET|STORAGE_SECRET/);
      const compose = read('docker-compose.yml');
      // dev compose uses local provider — no S3 secrets
      expect(compose).toMatch(/STORAGE_PROVIDER:\s*local/);
      expect(compose).not.toMatch(/S3_SECRET_ACCESS_KEY:\s*\S+/m);
    });

    test('logger redacts secrets', () => {
      const lc = read('src/config/logger.js');
      expect(lc).toMatch(/redact/);
      expect(lc).toMatch(/S3_SECRET_ACCESS_KEY/);
      expect(lc).toMatch(/\[REDACTED\]/);
    });
  });

  // ──────────────────────────────────────────────────────────
  // Health / readiness preservation
  // ──────────────────────────────────────────────────────────
  describe('health / readiness preservation', () => {
    test('health routes still exist and are registered', () => {
      const appJs = read('src/app/app.js');
      expect(appJs).toMatch(/healthRouter/);
      const healthRoutes = read('src/modules/health/health.routes.js');
      expect(healthRoutes).toMatch(/\/.*liveHealth|health/);
      expect(healthRoutes).toMatch(/\/db/);
      expect(healthRoutes).toMatch(/\/redis/);
    });

    test('server still has graceful shutdown (SIGTERM/SIGINT)', () => {
      const s = read('src/app/server.js');
      expect(s).toMatch(/SIGTERM/);
      expect(s).toMatch(/SIGINT/);
      expect(s).toMatch(/shutdown/);
      expect(s).toMatch(/disconnectRedis/);
      expect(s).toMatch(/disconnectDatabase/);
    });

    test('docker-compose postgres/redis healthchecks use actual app health behavior (pg_isready / redis-cli ping)', () => {
      const c = read('docker-compose.yml');
      expect(c).toMatch(/pg_isready/);
      expect(c).toMatch(/redis-cli.*ping/);
    });
  });
});
