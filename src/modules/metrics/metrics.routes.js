import { Router } from 'express';
import { metricsEndpoint } from './metrics.controller.js';

export const metricsRouter = Router();
metricsRouter.get('/', metricsEndpoint);
metricsRouter.get('/metrics', metricsEndpoint);