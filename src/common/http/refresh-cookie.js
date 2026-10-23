import { env } from '../../config/env.js';
import { parseExpiry } from '../../modules/auth/token-expiry.util.js';

// Phase 36: optional httpOnly cookie for refresh tokens, so browser JavaScript never sees them.
// Opt-in per request with `X-Refresh-Token-Transport: cookie` on login / refresh / logout (and storefront set-password).
// The cookie is only read when that header is present: a cross-site page can't add a custom header without a CORS
// preflight (refused for unknown origins), and SameSite keeps the browser from sending the cookie cross-site anyway.

export const TRANSPORT_HEADER = 'x-refresh-token-transport';
export const STAFF_COOKIE = { name: 'pulseops_refresh', path: '/api/v1/auth', maxAgeMs: () => parseExpiry(env.JWT_REFRESH_EXPIRY) };
export const shopperCookie = (slug) => ({ name: 'pulseops_shop_refresh', path: `/api/v1/storefront/${slug}/auth`, maxAgeMs: () => 30 * 86400000 });

export const wantsCookie = (req) => String(req.headers[TRANSPORT_HEADER] ?? '').toLowerCase() === 'cookie';

function readCookie(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) {
      try {
        return decodeURIComponent(part.slice(at + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const attributes = (cookie) => ({
  httpOnly: true,
  secure: env.REFRESH_COOKIE_SECURE,
  sameSite: env.REFRESH_COOKIE_SAMESITE,
  path: cookie.path,
  ...(env.REFRESH_COOKIE_DOMAIN ? { domain: env.REFRESH_COOKIE_DOMAIN } : {}),
});

/**
 * Before validation: in cookie mode, a request without `refreshToken` in its body takes it from the cookie.
 * After the handler: in cookie mode, a `refreshToken` in the response moves into the cookie (and out of the body);
 * `clear` (logout) removes the cookie.
 */
export function refreshCookie(cookieFor, { clear = false } = {}) {
  return (req, res, next) => {
    if (!wantsCookie(req)) return next();
    const cookie = typeof cookieFor === 'function' ? cookieFor(req) : cookieFor;
    req.body = req.body ?? {};
    if (!req.body.refreshToken) {
      const fromCookie = readCookie(req, cookie.name);
      if (fromCookie) req.body.refreshToken = fromCookie;
    }
    const json = res.json.bind(res);
    res.json = (body) => {
      const ok = res.statusCode < 400;
      if (ok && clear) res.clearCookie(cookie.name, attributes(cookie));
      const token = body?.data?.refreshToken;
      if (ok && token) {
        res.cookie(cookie.name, token, { ...attributes(cookie), maxAge: cookie.maxAgeMs() });
        const data = { ...body.data, refreshTokenTransport: 'cookie' };
        delete data.refreshToken;
        return json({ ...body, data });
      }
      return json(body);
    };
    next();
  };
}
