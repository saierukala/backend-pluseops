import { Router } from 'express';
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
} from './auth.controller.js';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from './auth.validation.js';
import { authenticate } from './auth.middleware.js';

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

// Public endpoints
authRouter.post('/register', validate(registerSchema), register);
authRouter.post('/login', validate(loginSchema), login);
authRouter.post('/refresh', validate(refreshSchema), refresh);
authRouter.post('/logout', validate(logoutSchema), logout);
authRouter.post('/forgot-password', validate(forgotPasswordSchema), forgotPassword);
authRouter.post('/reset-password', validate(resetPasswordSchema), resetPassword);
authRouter.post('/verify-email', validate(verifyEmailSchema), verifyEmail);

// Protected endpoints
authRouter.get('/me', authenticate(), me);