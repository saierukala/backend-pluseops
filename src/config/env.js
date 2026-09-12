import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

function loadProjectEnvFile() {
  const envFilePath = resolve(process.cwd(), '.env');
  if (!existsSync(envFilePath) || typeof process.loadEnvFile !== 'function') return;

  // Deployment-provided variables must take precedence over local .env values.
  const deploymentEnvironment = { ...process.env };
  process.loadEnvFile(envFilePath);
  Object.assign(process.env, deploymentEnvironment);
}

loadProjectEnvFile();

const booleanFromString = z.enum(['true', 'false']).transform((value) => value === 'true');

const isTestEnv = process.env.NODE_ENV === 'test';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  REQUEST_BODY_LIMIT: z.string().default('1mb'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  TRUST_PROXY: booleanFromString.default(false),
  FAIL_ON_DEPENDENCY_ERROR: booleanFromString.optional(),
  JWT_ACCESS_SECRET: isTestEnv ? z.string().optional() : z.string().min(32),
  JWT_REFRESH_SECRET: isTestEnv ? z.string().optional() : z.string().min(32),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),
  PASSWORD_RESET_EXPIRY: z.string().default('1h'),
  EMAIL_VERIFICATION_EXPIRY: z.string().default('24h'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new Error(`Invalid environment configuration: ${issues}`);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
  failOnDependencyError: parsed.data.FAIL_ON_DEPENDENCY_ERROR ?? parsed.data.NODE_ENV === 'production'
};