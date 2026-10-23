import { resolvePlatformAdminCredentials } from '../../prisma/platform-admin-credentials.js';

const STRONG = { PLATFORM_ADMIN_EMAIL: 'ops@example.com', PLATFORM_ADMIN_PASSWORD: 'Very#Strong12345' };

describe('Seed platform admin credentials (Phase 26)', () => {
  it.each(['development', 'test', undefined])('falls back to the dev default when NODE_ENV=%s', (NODE_ENV) => {
    const result = resolvePlatformAdminCredentials({ NODE_ENV });
    expect(result.usingDefaults).toBe(true);
    expect(result.email).toBeTruthy();
  });

  it.each(['production', 'staging'])('requires env vars when NODE_ENV=%s', (NODE_ENV) => {
    expect(() => resolvePlatformAdminCredentials({ NODE_ENV })).toThrow(/required/);
    expect(() => resolvePlatformAdminCredentials({ NODE_ENV, PLATFORM_ADMIN_EMAIL: 'ops@example.com' })).toThrow(/required/);
  });

  it('rejects weak or default passwords outside development', () => {
    const env = { NODE_ENV: 'production', PLATFORM_ADMIN_EMAIL: 'ops@example.com' };
    expect(() => resolvePlatformAdminCredentials({ ...env, PLATFORM_ADMIN_PASSWORD: 'short#A1' })).toThrow(/12 characters/);
    expect(() => resolvePlatformAdminCredentials({ ...env, PLATFORM_ADMIN_PASSWORD: 'alllowercase#12345' })).toThrow(/12 characters/);
    expect(() => resolvePlatformAdminCredentials({ ...env, PLATFORM_ADMIN_EMAIL: 'not-an-email', PLATFORM_ADMIN_PASSWORD: STRONG.PLATFORM_ADMIN_PASSWORD })).toThrow(/email/);
  });

  it('accepts strong credentials in production', () => {
    expect(resolvePlatformAdminCredentials({ NODE_ENV: 'production', ...STRONG })).toEqual({
      email: STRONG.PLATFORM_ADMIN_EMAIL,
      password: STRONG.PLATFORM_ADMIN_PASSWORD,
      usingDefaults: false,
    });
  });
});
