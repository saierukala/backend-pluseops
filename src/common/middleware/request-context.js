import { randomUUID } from 'node:crypto';

export function requestContext(req, res, next) {
  req.id = req.get('x-request-id') || randomUUID();
  req.context = req.context || {};
  res.setHeader('x-request-id', req.id);
  next();
}

export function setTenantContext(tenantId) {
  return (req, res, next) => {
    if (tenantId) {
      req.context.tenantId = tenantId;
    }
    next();
  };
}