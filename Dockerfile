# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

# Copy everything fresh every time (bust cache via timestamp)
ARG CACHE_BUST_TS=20260412_1725
COPY tsconfig.json ./
COPY src/ ./src/

RUN echo "Building at $CACHE_BUST_TS" && rm -rf dist && npm run build && ls -la dist/

# Stage 2: Production
FROM node:20-alpine AS production

# Re-declare the build arg in this stage so we can promote it to an env var.
# This lets /build-info report which build is actually running.
ARG CACHE_BUST_TS=unknown
ENV BUILD_ID=${CACHE_BUST_TS}

WORKDIR /app

# Security: run as non-root user
RUN addgroup -g 1001 -S botuser && \
    adduser -S botuser -u 1001

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY drizzle/ ./drizzle/

USER botuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
