# ============================================================
# Drive2Social Publisher — backend production image
# Multi-stage: build (TypeScript) → slim runtime (prod deps only).
# The service worker / PWA lives in the frontend build; this image
# serves the API only. Run: node backend/dist/index.js
# ============================================================

# ---------- build stage ----------
FROM node:20-slim AS build
WORKDIR /app

# Workspace manifests first (better layer caching).
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json

# Full install including devDependencies (needed to compile TypeScript).
# NOTE: --include=dev is explicit because some hosts (e.g. Render) set
# NODE_ENV=production during the Docker build, which would otherwise make
# npm omit devDependencies and the tsc build would fail.
RUN npm ci --workspace=@drive2social/backend --include=dev && npm cache clean --force

# Sources for the workspaces the backend image needs.
COPY shared/ ./shared/
COPY backend/ ./backend/

RUN npm run build --workspace=shared \
 && npm run build --workspace=backend

# ---------- runtime stage ----------
FROM node:20-slim
ENV NODE_ENV=production

# Non-root user for least privilege.
RUN groupadd -r appuser \
 && useradd -r -g appuser -d /home/appuser -s /usr/sbin/nologin appuser

WORKDIR /app

# Manifests for the workspaces present in this image.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json

# Production dependencies only (no devDependencies, no build tools).
RUN npm ci --omit=dev && npm cache clean --force

# Compiled output from the build stage.
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/backend/dist ./backend/dist

USER appuser
EXPOSE 8080

# Cloud Run sets PORT; default to 8080 for local `docker run`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'8080')+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "backend/dist/index.js"]
