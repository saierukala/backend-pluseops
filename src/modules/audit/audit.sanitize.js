// Sanitization for audit/activity logging - never persist secrets
const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'currentpassword',
  'newpassword',
  'confirmpassword',
  'hash',
  'token',
  'refreshtoken',
  'accesstoken',
  'secret',
  'apisecret',
  'webhooksecret',
  'providersecret',
  'providercredentials',
  'authorization',
  'cookie',
  'credentials',
  'clientsecret',
  'privatekey',
  'seed',
  'salt',
  'tokenhash',
  'token_hash',
  'refreshtokenhash',
  'emailverificationtoken',
  'passwordresettoken',
]);

const REDACTED = '[REDACTED]';

function isSensitiveKey(key) {
  if (!key) return false;
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  return SENSITIVE_KEYS.has(normalized);
}

export function sanitizeValue(value, depth = 0, maxDepth = 8) {
  if (depth > maxDepth) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  // Prisma Decimal handling - convert to string via toString if has method
  if (typeof value === 'object' && value !== null && typeof value.toString === 'function' && value.constructor && value.constructor.name === 'Decimal') {
    try { return value.toString(); } catch { return String(value); }
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v, depth + 1, maxDepth));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = sanitizeValue(v, depth + 1, maxDepth);
      }
    }
    return out;
  }
  return value;
}

export function sanitizeAuditValues(oldValue, newValue) {
  return {
    oldValue: oldValue ? sanitizeValue(oldValue) : null,
    newValue: newValue ? sanitizeValue(newValue) : null,
  };
}

export function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return metadata ? sanitizeValue(metadata) : {};
  return sanitizeValue(metadata);
}
