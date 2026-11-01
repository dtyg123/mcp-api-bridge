# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: install everything, compile TypeScript, drop dev dependencies.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

RUN npm run build && npm prune --omit=dev

# ---------------------------------------------------------------------------
# Runtime stage: minimal image, non-root user, tini as PID 1.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    BRIDGE_CONFIG=/app/bridge.config.yaml

RUN apk add --no-cache tini

WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node bridge.config.example.yaml ./bridge.config.yaml

# Sources added through the web admin UI are persisted here; mount a volume.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
VOLUME ["/app/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini","--","node","dist/src/index.js"]
CMD ["--config","/app/bridge.config.yaml"]
