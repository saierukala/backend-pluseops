import { z } from 'zod';

export const registerSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(8).max(128).regex(/[A-Z]/).regex(/[a-z]/).regex(/[0-9]/).regex(/[^A-Za-z0-9]/),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    tenantId: z.string().uuid().optional(),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(1),
    scope: z.enum(['platform', 'tenant']).optional(),
    tenantId: z.string().uuid().optional(),
    tenantSlug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  }),
});

export const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1),
  }),
});

export const logoutSchema = z.object({
  body: z.object({
    refreshToken: z.string().optional(),
  }),
});

export const forgotPasswordSchema = z.object({
  body: z.object({
    email: z.string().email(),
    tenantId: z.string().uuid().optional(),
    tenantSlug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  }),
});

export const resetPasswordSchema = z.object({
  body: z.object({
    token: z.string().min(1),
    password: z.string().min(8).max(128).regex(/[A-Z]/).regex(/[a-z]/).regex(/[0-9]/).regex(/[^A-Za-z0-9]/),
  }),
});

export const verifyEmailSchema = z.object({
  body: z.object({
    token: z.string().min(1),
  }),
});
// ── Phase 28: account self-service ───────────────────────────────────

const strongPassword = z.string().min(8).max(128).regex(/[A-Z]/).regex(/[a-z]/).regex(/[0-9]/).regex(/[^A-Za-z0-9]/);

export const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1).max(128),
    newPassword: strongPassword,
  }).strict(),
});

// Only display-name fields: email, status and password have their own flows
export const updateMeSchema = z.object({
  body: z.object({
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
  }).strict().refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  }),
});

export const sessionIdParamSchema = z.object({
  params: z.object({
    sessionId: z.string().uuid(),
  }),
});
