import { Router } from 'express';
import { refreshCookie, STAFF_COOKIE } from '../../common/http/refresh-cookie.js';
import { z } from 'zod';
import {
  register,
  login,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  verifyEmail,
  me,
  changePassword,
  updateMe,
  resendVerification,
  listSessions,
  revokeSession,
  logoutAll,
} from './auth.controller.js';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  changePasswordSchema,
  updateMeSchema,
  sessionIdParamSchema,
} from './auth.validation.js';
import { authenticate, authenticateAnyScope } from './auth.middleware.js';
import { createAuthLimiter } from '../../common/middleware/rate-limiters.js';
import { env } from '../../config/env.js';

const authLimiter = env.NODE_ENV !== 'test' ? createAuthLimiter() : (req, res, next) => next();

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({
      body: req.body,
      params: req.params,
      query: req.query,
    });
    if (!result.success) {
      const error = new z.ZodError(result.error.issues);
      return next(error);
    }
    req.body = result.data.body;
    req.params = result.data.params;
    next();
  };
}

export const authRouter = Router();

// Public endpoints — authLimiter protects against brute force / credential stuffing
authRouter.post('/register', authLimiter, validate(registerSchema), register);
// Phase 36: `X-Refresh-Token-Transport: cookie` keeps the refresh token in an httpOnly cookie instead of the body
authRouter.post('/login', authLimiter, refreshCookie(STAFF_COOKIE), validate(loginSchema), login);
authRouter.post('/refresh', authLimiter, refreshCookie(STAFF_COOKIE), validate(refreshSchema), refresh);
authRouter.post('/logout', refreshCookie(STAFF_COOKIE, { clear: true }), validate(logoutSchema), logout);
authRouter.post('/forgot-password', authLimiter, validate(forgotPasswordSchema), forgotPassword);
authRouter.post('/reset-password', authLimiter, validate(resetPasswordSchema), resetPassword);
authRouter.post('/verify-email', authLimiter, validate(verifyEmailSchema), verifyEmail);

// Protected endpoints
authRouter.get('/me', authenticate(), me);
authRouter.patch('/me', authenticate(), validate(updateMeSchema), updateMe);

// Account self-service (Phase 28) — tenant and platform users alike
authRouter.post('/change-password', authLimiter, authenticateAnyScope(), validate(changePasswordSchema), changePassword);
authRouter.post('/resend-verification', authLimiter, authenticate(), resendVerification);
authRouter.get('/sessions', authenticateAnyScope(), listSessions);
authRouter.delete('/sessions/:sessionId', authenticateAnyScope(), validate(sessionIdParamSchema), revokeSession);
authRouter.post('/logout-all', authenticateAnyScope(), logoutAll);