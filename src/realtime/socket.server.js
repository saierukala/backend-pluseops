import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { socketAuthMiddleware } from './socket.auth.js';
import { setIoInstance } from './realtime.service.js';

export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: env.corsOrigins,
      credentials: true,
    },
    // Do not serve client files
    serveClient: false,
  });

  // Authentication middleware - must be before connection
  io.use(socketAuthMiddleware);

  io.on('connection', (socket) => {
    const ctx = socket.context;
    logger.info({ socketId: socket.id, userId: ctx.userId, tenantId: ctx.tenantId }, 'Socket connected');

    // Auto-join tenant and user rooms derived from authenticated context only
    const tenantRoom = `tenant:${ctx.tenantId}`;
    const userRoom = `user:${ctx.userId}`;
    socket.join(tenantRoom);
    socket.join(userRoom);

    // Notify client of successful auth + rooms (no sensitive data)
    socket.emit('connected', {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      rooms: [tenantRoom, userRoom],
    });

    // Handle room join attempts - STRICT: only allow own rooms, reject others
    socket.on('join', (payload, ack) => {
      try {
        // Accept string room or object { room: '...' }
        let requestedRoom = null;
        if (typeof payload === 'string') requestedRoom = payload;
        else if (payload && typeof payload.room === 'string') requestedRoom = payload.room;
        else if (payload && typeof payload.rooms === 'string') requestedRoom = payload.rooms;

        if (!requestedRoom) {
          if (typeof ack === 'function') ack({ success: false, error: { code: 'INVALID_ROOM', message: 'Room name required' } });
          return;
        }

        const allowedRooms = new Set([`tenant:${ctx.tenantId}`, `user:${ctx.userId}`]);
        if (!allowedRooms.has(requestedRoom)) {
          logger.warn({ socketId: socket.id, userId: ctx.userId, tenantId: ctx.tenantId, requestedRoom }, 'Socket rejected room join - not allowed');
          socket.emit('error', { code: 'FORBIDDEN', message: 'Not allowed to join room' });
          if (typeof ack === 'function') ack({ success: false, error: { code: 'FORBIDDEN', message: 'Not allowed to join room' } });
          return;
        }

        // Already joined, but acknowledge
        if (typeof ack === 'function') ack({ success: true, room: requestedRoom });
      } catch (err) {
        logger.error({ err, socketId: socket.id }, 'Socket join handler error');
        if (typeof ack === 'function') ack({ success: false, error: { code: 'INTERNAL_ERROR' } });
      }
    });

    // Also handle generic subscribe attempt with same guard
    socket.on('subscribe', (payload, ack) => {
      let requestedRoom = null;
      if (typeof payload === 'string') requestedRoom = payload;
      else if (payload && typeof payload.room === 'string') requestedRoom = payload.room;
      else if (payload && typeof payload.channel === 'string') requestedRoom = payload.channel;

      const allowedRooms = new Set([`tenant:${ctx.tenantId}`, `user:${ctx.userId}`]);
      if (!requestedRoom || !allowedRooms.has(requestedRoom)) {
        logger.warn({ socketId: socket.id, requestedRoom }, 'Subscribe rejected');
        socket.emit('error', { code: 'FORBIDDEN', message: 'Not allowed to subscribe' });
        if (typeof ack === 'function') ack({ success: false, error: { code: 'FORBIDDEN' } });
        return;
      }
      if (typeof ack === 'function') ack({ success: true, room: requestedRoom });
    });

    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, userId: ctx.userId, reason }, 'Socket disconnected');
    });

    socket.on('error', (err) => {
      logger.warn({ err, socketId: socket.id }, 'Socket error');
    });
  });

  // Handle auth failures gracefully
  io.engine.on('connection_error', (err) => {
    logger.warn({ code: err.code, message: err.message, context: err.context }, 'Socket connection_error');
  });

  setIoInstance(io);
  return io;
}

export function closeSocketServer(io) {
  if (!io) return;
  setIoInstance(null);
  io.close();
}
