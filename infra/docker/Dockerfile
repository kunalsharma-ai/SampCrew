# syntax=docker/dockerfile:1.7
# CREW production images, one Dockerfile with a target per service. Build from the repository root:
#
#   docker build -f infra/docker/Dockerfile --target api     -t crew-api .
#   docker build -f infra/docker/Dockerfile --target web     -t crew-web .
#   docker build -f infra/docker/Dockerfile --target console -t crew-console .
#   docker build -f infra/docker/Dockerfile --target tools   -t crew-tools .   # migrations, seed, backups
#
# Behind a proxy that re-signs TLS, pass its CA so pnpm can download packages (it is never kept in an image):
#   docker build --secret id=ca,src=/path/to/ca.pem ...
# No secrets are baked in: every image reads its configuration from the environment at run time.

# Pin by digest in your registry for repeatable builds, e.g. --build-arg NODE_IMAGE=node:26.12.1-alpine@sha256:...
ARG NODE_IMAGE=node:26.12.1-alpine
# Must be the same major version as the database server (PostgreSQL 16).
ARG POSTGRES_IMAGE=postgres:16-alpine

FROM ${NODE_IMAGE} AS base
RUN corepack enable
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
# Built on the PostgreSQL image itself, so pg_dump, pg_restore and psql are exactly the server's major version, with
# Node.js copied in from the Node image (both Alpine). No packages are downloaded for this stage.
FROM ${POSTGRES_IMAGE} AS tools
COPY --from=base /usr/local/bin/node /usr/local/bin/node
# The database package with its migrations and scripts (and tsx to run them), nothing from the apps.
COPY --from=build /out/db /app/db
COPY infra/deploy/scripts /app/infra/deploy/scripts
RUN chmod +x /app/infra/deploy/scripts/*.sh \
 && mkdir -p /backups /data/files && chown postgres:postgres /backups /data/files \
 && node --version
WORKDIR /app
USER postgres
ENTRYPOINT []
# Default job: apply migrations, then sync the catalogue and bootstrap the first Super Admin. Both are safe to repeat.
CMD ["/app/infra/deploy/scripts/migrate.sh"]
