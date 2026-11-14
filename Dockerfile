# syntax=docker/dockerfile:1

# ---- build: compile TypeScript (typescript is a devDependency) ----
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime: production dependencies + compiled output only ----
FROM node:24-slim
ENV NODE_ENV=production \
    PORT=8787 \
    AEGIS_DB_PATH=/data/aegis.db
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
# /data holds the SQLite database; mount a volume here to keep state across restarts.
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# exec-form + direct node so SIGTERM from `docker stop` reaches the process and triggers
# graceful shutdown (npm would swallow it).
CMD ["node", "--experimental-wasm-modules", "dist/api/main.js"]
