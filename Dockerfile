# syntax=docker/dockerfile:1

# ──────────────────────────────────────────────
# Stage 1 — dependencies (includes native build tools for argon2/bcrypt)
# ──────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

# argon2 / node-gyp need python3, make, g++
RUN apk add --no-cache python3 make g++ pkgconfig

COPY package.json package-lock.json ./
COPY prisma ./prisma

# Reproducible install — uses package-lock.json exact versions
RUN npm ci

# Generate Prisma Client (needs schema + installed deps)
RUN npx prisma generate

# ──────────────────────────────────────────────
# Stage 2 — production runtime
# ──────────────────────────────────────────────
FROM node:22-alpine AS production
WORKDIR /app

ENV NODE_ENV=production

# tini = correct PID 1 signal forwarding for graceful shutdown (SIGTERM/SIGINT)
# wget = used by Docker HEALTHCHECK (http://localhost:3000/health)
RUN apk add --no-cache tini wget

# Create non-root user (compatible with Kubernetes restricted PSA)
RUN addgroup -S pulseops && adduser -S pulseops -G pulseops

# Copy deps + generated client + source
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY package.json package-lock.json ./
COPY src ./src
COPY eslint.config.js jest.config.js ./
COPY scripts ./scripts

# Storage directory (local provider) — owned by non-root user
RUN mkdir -p /app/storage && chown -R pulseops:pulseops /app

USER pulseops

EXPOSE 3000

# Healthcheck uses the application's actual liveness endpoint (no DB/Redis needed)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["tini", "--"]

# Default command = API. Worker overrides command in compose: `node src/worker.js`
CMD ["node", "src/app/server.js"]
