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

export function signAccessToken(payload) {
  return jwt.sign(payload, accessSecret, {
    expiresIn: env.JWT_ACCESS_EXPIRY,
    issuer: 'pulseops',
    audience: 'pulseops-api',
    algorithm: 'HS256',
  });
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
  return jwt.verify(token, accessSecret, {
    issuer: 'pulseops',
    audience: 'pulseops-api',
    algorithms: ['HS256'],
  });
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