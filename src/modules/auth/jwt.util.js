import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';

const DEFAULT_ACCESS_SECRET = 'test-access-secret-min-32-chars-long-for-testing';
const DEFAULT_REFRESH_SECRET = 'test-refresh-secret-min-32-chars-long-for-testing';

// In production, JWT secrets MUST be explicitly configured via environment variables
// Development/test can use defaults
const isProduction = env.NODE_ENV === 'production';
const accessSecret = isProduction
  ? env.JWT_ACCESS_SECRET
  : (env.JWT_ACCESS_SECRET || DEFAULT_ACCESS_SECRET);
const refreshSecret = isProduction
  ? env.JWT_REFRESH_SECRET
  : (env.JWT_REFRESH_SECRET || DEFAULT_REFRESH_SECRET);

if (isProduction && (!env.JWT_ACCESS_SECRET || !env.JWT_REFRESH_SECRET)) {
  throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be set in production');
}

const CLAIMS = { issuer: 'pulseops', audience: 'pulseops-api' };

// PEMs in environment variables often arrive with literal "\n"; every PEM block in the value is one key
const pemBlocks = (value) => (value ? value.replace(/\\n/g, '\n').match(/-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g) ?? [] : []);

/** RFC 7638 thumbprint of an RSA public key: a stable kid that needs no configuration. */
export function thumbprint(publicKey) {
  const { e, kty, n } = publicKey.export({ format: 'jwk' });
  return crypto.createHash('sha256').update(JSON.stringify({ e, kty, n })).digest('base64url');
}

function rsaPublicKey(pem) {
  const key = crypto.createPublicKey(pem);
  if (key.asymmetricKeyType !== 'rsa') throw new Error('JWT keys must be RSA keys');
  if (key.asymmetricKeyDetails.modulusLength < 2048) throw new Error('JWT RSA keys must be at least 2048 bits');
  return key;
}

/**
 * Phase 36: access-token signing. HS256 (shared secret, the default) or RS256 (private key here; anyone can verify with
 * the public keys published at /.well-known/jwks.json). Rotation: put the new private key in JWT_PRIVATE_KEY and the
 * old public key in JWT_PREVIOUS_PUBLIC_KEYS until the last old token has expired (JWT_ACCESS_EXPIRY).
 */
export function createAccessTokenKeys({ algorithm = 'HS256', secret, privateKeyPem, previousPublicKeysPem } = {}) {
  if (algorithm === 'HS256') {
    return {
      algorithm,
      sign: (payload, expiresIn) => jwt.sign(payload, secret, { ...CLAIMS, expiresIn, algorithm: 'HS256' }),
      verify: (token) => jwt.verify(token, secret, { ...CLAIMS, algorithms: ['HS256'] }),
      jwks: () => ({ keys: [] }),
    };
  }
  const [privatePem] = pemBlocks(privateKeyPem);
  if (!privatePem) throw new Error('JWT_ALGORITHM=RS256 needs JWT_PRIVATE_KEY (a PEM RSA private key)');
  const privateKey = crypto.createPrivateKey(privatePem);
  const current = rsaPublicKey(crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }));
  const kid = thumbprint(current);
  const verifiers = new Map([[kid, current]]);
  for (const pem of pemBlocks(previousPublicKeysPem)) {
    const key = rsaPublicKey(pem);
    verifiers.set(thumbprint(key), key);
  }
  return {
    algorithm,
    kid,
    sign: (payload, expiresIn) => jwt.sign(payload, privateKey, { ...CLAIMS, expiresIn, algorithm: 'RS256', keyid: kid }),
    verify: (token) => {
      const header = jwt.decode(token, { complete: true })?.header;
      // Only RS256 with a key we know: an HS256 token (or alg "none") never reaches a verifier
      const key = header?.alg === 'RS256' ? verifiers.get(header.kid) : undefined;
      if (!key) throw new jwt.JsonWebTokenError('invalid signature');
      return jwt.verify(token, key, { ...CLAIMS, algorithms: ['RS256'] });
    },
    jwks: () => ({
      keys: [...verifiers].map(([id, key]) => ({ ...key.export({ format: 'jwk' }), kid: id, use: 'sig', alg: 'RS256' })),
    }),
  };
}

const accessKeys = createAccessTokenKeys({
  algorithm: env.JWT_ALGORITHM,
  secret: accessSecret,
  privateKeyPem: env.JWT_PRIVATE_KEY,
  previousPublicKeysPem: env.JWT_PREVIOUS_PUBLIC_KEYS,
});

export function signAccessToken(payload, { expiresIn = env.JWT_ACCESS_EXPIRY } = {}) {
  return accessKeys.sign(payload, expiresIn);
}

export function signRefreshToken(payload) {
  return jwt.sign(payload, refreshSecret, {
    expiresIn: env.JWT_REFRESH_EXPIRY,
    issuer: 'pulseops',
    audience: 'pulseops-api',
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(token) {
  return accessKeys.verify(token);
}

/** Public keys for verifying access tokens (empty with HS256, whose secret is never published). */
export function getJwks() {
  return accessKeys.jwks();
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, refreshSecret, {
    issuer: 'pulseops',
    audience: 'pulseops-api',
    algorithms: ['HS256'],
  });
}

export function decodeToken(token) {
  return jwt.decode(token);
}
