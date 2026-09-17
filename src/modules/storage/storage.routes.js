import { Router } from 'express';
import { getSignedFile, getAuthenticatedFile } from './storage.controller.js';
import { authenticate } from '../auth/auth.middleware.js';

export const storageRouter = Router();

// Signed URL access (no auth, HMAC verified, expiry checked)
// GET /api/v1/storage/signed?key=tenants/...&expires=...&signature=...
storageRouter.get('/signed', getSignedFile);

// Authenticated access (Bearer, tenant isolation)
// GET /api/v1/storage/file?key=tenants/...
storageRouter.get('/file', authenticate(), getAuthenticatedFile);
