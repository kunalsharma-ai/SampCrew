# Production image for the CREW API. Build from the repository root:
#   docker build -f infra/docker/api.Dockerfile -t crew-api .
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @crew/contracts --filter @crew/db run build && pnpm --filter @crew/api run build
RUN pnpm --filter @crew/api deploy --prod --legacy /out

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out .
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:4000/api/v1/health/live || exit 1
CMD ["node", "dist/main.js"]
