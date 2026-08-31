import { Router } from 'express';
import { databaseHealth, liveHealth, redisHealth } from './health.controller.js';

export const healthRouter = Router();
healthRouter.get('/', liveHealth);
healthRouter.get('/db', databaseHealth);
healthRouter.get('/redis', redisHealth);
