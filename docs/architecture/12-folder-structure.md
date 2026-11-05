# 12. Project Folder Structure

```
crew/
├── apps/
│   ├── api/                      NestJS modular monolith (REST /api/v1, workers, websockets)
│   │   ├── src/platform/         kernel: config, database (RLS), context, auth, authz, entitlements, audit, events, http
│   │   ├── src/modules/          domain modules (identity, tenancy, organization, access, billing, platform-admin, ...)
│   │   └── test/                 integration tests against a real PostgreSQL
│   ├── web/                      Next.js tenant Web Portal (+ public career pages in Phase 4)
│   ├── console/                  Next.js SAMPLEDGE Super Admin Console
│   ├── mobile/                   React Native (Expo) app, Phase 7
│   └── device-agent/             Go sync agent for LAN attendance devices, Phase 3
├── packages/
│   ├── contracts/                zod schemas, API types, permission catalogue, role templates, feature catalogue
│   ├── db/                       SQL migrations (incl. RLS), migration runner, catalogue sync, tenant provisioning, seed
│   ├── ui/                       design tokens, Tailwind preset, React components
│   ├── config/                   shared tsconfig
│   └── payroll-in/               India payroll country package, Phase 5
├── infra/
│   ├── docker/                   docker compose for local (Postgres, Redis, MinIO, Mailpit) and Dockerfiles
│   └── terraform/                cloud infrastructure modules per environment (Phase 1 skeleton, filled before staging)
├── docs/
│   ├── architecture/             this pack
│   ├── api/                      generated OpenAPI spec and guides
│   ├── security.md
│   └── phases/                   per-phase completion reports (features, tests, dependencies)
├── .github/workflows/            CI (lint, typecheck, test with Postgres, build)
├── .env.example                  every environment variable, no secrets
├── package.json, pnpm-workspace.yaml, tsconfig.base.json
└── README.md                     getting started
```

## Conventions

- Package names are `@crew/<name>`.
- Apps never import from other apps. Shared code goes to `packages/`.
- API modules follow `module.ts / controller.ts / service.ts / *.schema.ts`; tests sit next to code (`*.spec.ts`) for units and in `apps/api/test` for integration.
- Migrations are append-only and numbered; never edit a migration that has been applied in a shared environment.
