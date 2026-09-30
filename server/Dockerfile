# Muse → AI Passport bridge. Build from the repository root:
#   docker compose -f server/docker-compose.yml build
FROM node:22-slim

ENV NODE_ENV=production DATA_DIR=/data PORT=8787
WORKDIR /app

# Only the three runtime dependencies of desktop-pet/native (no Electron,
# no Puppeteer). Installed at /app so both /app/server and
# /app/desktop-pet/native resolve them.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY desktop-pet/native ./desktop-pet/native
COPY server/*.cjs ./server/

RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/bridge.cjs"]
