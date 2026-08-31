import { randomUUID } from 'node:crypto';

export function requestContext(req, res, next) {
  req.id = req.get('x-request-id') || randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
}
