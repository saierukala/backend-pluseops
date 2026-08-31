import { AppError } from '../errors/app-error.js';

export function notFoundHandler(req, _res, next) {
  next(new AppError(`Route ${req.method} ${req.originalUrl} was not found`, {
    statusCode: 404,
    code: 'ROUTE_NOT_FOUND'
  }));
}
