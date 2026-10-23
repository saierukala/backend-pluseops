/**
 * Platform admin credentials for the seed.
 *
 * Development/test may fall back to the local default account. Every other environment
 * must supply PLATFORM_ADMIN_EMAIL and a strong PLATFORM_ADMIN_PASSWORD, so a deployed
 * database can never be seeded with the well-known default.
 */
const DEV_DEFAULT_EMAIL = 'sairram@gmail.com';
const DEV_DEFAULT_PASSWORD = 'Sairram@123';

// Stricter than the tenant-admin rule in platform.validation.js (12+ chars): this account controls every tenant
const STRONG_PASSWORD = [/.{12,}/, /[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function resolvePlatformAdminCredentials(environment) {
  const nodeEnv = environment.NODE_ENV || 'development';
  const allowDefaults = nodeEnv === 'development' || nodeEnv === 'test';
  const email = environment.PLATFORM_ADMIN_EMAIL;
  const password = environment.PLATFORM_ADMIN_PASSWORD;

  if (!email || !password) {
    if (!allowDefaults) {
      throw new Error(`PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD are required when NODE_ENV=${nodeEnv}`);
    }
    return { email: email || DEV_DEFAULT_EMAIL, password: password || DEV_DEFAULT_PASSWORD, usingDefaults: true };
  }

  if (!allowDefaults) {
    if (!EMAIL.test(email)) throw new Error('PLATFORM_ADMIN_EMAIL must be a valid email address');
    if (!STRONG_PASSWORD.every((rule) => rule.test(password))) {
      throw new Error('PLATFORM_ADMIN_PASSWORD must be at least 12 characters with upper, lower, digit and symbol');
    }
    if (password === DEV_DEFAULT_PASSWORD) {
      throw new Error('PLATFORM_ADMIN_PASSWORD must not be the development default');
    }
  }
  return { email, password, usingDefaults: false };
}
