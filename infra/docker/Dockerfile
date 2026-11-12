# syntax=docker/dockerfile:1.7
# SampCrew production images, one Dockerfile with a target per service. Build from the repository root:
#
#   docker build -f infra/docker/Dockerfile --target api     -t crew-api .
#   docker build -f infra/docker/Dockerfile --target web     -t crew-web .
#   docker build -f infra/docker/Dockerfile --target console -t crew-console .
#   docker build -f infra/docker/Dockerfile --target tools   -t crew-tools .   # migrations, seed, backups
#
# Behind a proxy that re-signs TLS, pass its CA so pnpm can download packages (it is never kept in an image):
#   docker build --secret id=ca,src=/path/to/ca.pem ...
# No secrets are baked in: every image reads its configuration from the environment at run time.

# Pin by digest in your registry for repeatable builds, e.g. --build-arg NODE_IMAGE=node:26.13.1-alpine@sha256:...
ARG NODE_IMAGE=node:26.13.1-alpine
# MongoDB Database Tools for backups and restores (mongodump, mongorestore), from Alpine's community repository.
# 100.x supports MongoDB 4.2 to 8.0. Pin a newer release here when upgrading the server.
ARG MONGO_TOOLS_VERSION=100.14.1-r5

FROM ${NODE_IMAGE} AS base
# Node.js 25 and later no longer ship Corepack, so install a pinned copy; it then runs the pnpm version named in
# package.json ("packageManager"). Only the build stage uses it: the runtime images start again from NODE_IMAGE.
ARG COREPACK_VERSION=0.36.0
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm install --global --no-fund --no-audit corepack@${COREPACK_VERSION} \
 && npm cache clean --force \
 && corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    pnpm install --frozen-lockfile
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone
RUN pnpm build
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    pnpm --filter @crew/api deploy --prod --legacy --prefer-offline /out/api \
 && pnpm --filter @crew/db deploy --legacy --prefer-offline /out/db

# --- API -------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /out/api .
# Uploaded files live here; mount a volume (or switch to object storage when it is wired up).
RUN mkdir -p /data/files && chown node:node /data/files
ENV STORAGE_DIR=/data/files
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:4000/api/v1/health/ready >/dev/null || exit 1
CMD ["node", "dist/main.js"]

# --- Web Portal ------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]

# --- Super Admin Console ---------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS console
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3001
COPY --from=build --chown=node:node /app/apps/console/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/console/.next/static ./apps/console/.next/static
COPY --from=build --chown=node:node /app/apps/console/public ./apps/console/public
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:3001/healthz >/dev/null || exit 1
CMD ["node", "apps/console/server.js"]

# --- Tools: migrations, seed, backups and the restore drill ----------------------------------------------------
# rclone copies the backups off the server (BACKUP_REMOTE). Its official image holds one static binary; pin it here.
FROM rclone/rclone:1.75.2 AS rclone

FROM ${NODE_IMAGE} AS tools
ARG MONGO_TOOLS_VERSION
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then cat /etc/ssl/certs/ca-certificates.crt /run/secrets/ca > /tmp/build-ca.pem; export SSL_CERT_FILE=/tmp/build-ca.pem; fi; \
    apk add --no-cache "mongodb-tools=${MONGO_TOOLS_VERSION}" \
 && rm -f /tmp/build-ca.pem \
 && mongodump --version | head -1 \
 && rclone version | head -1
# The database package with its scripts (and tsx to run them), nothing from the apps.
COPY --from=build --chown=node:node /out/db /app/db
COPY infra/deploy/scripts /app/infra/deploy/scripts
RUN chmod +x /app/infra/deploy/scripts/*.sh \
 && mkdir -p /backups /data/files && chown node:node /backups /data/files
WORKDIR /app
USER node
ENTRYPOINT []
# Default job: apply migrations, then sync the catalogue and bootstrap the first Super Admin. Both are safe to repeat.
CMD ["/app/infra/deploy/scripts/migrate.sh"]
