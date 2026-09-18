import { Router } from 'express';
import { readinessCheck, liveHealth } from './readiness.controller.js';

export const readinessRouter = Router();
readinessRouter.get('/', readinessCheck);
readinessRouter.get('/live', liveHealth);