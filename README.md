# CREW by SAMPLEDGE

> One Intelligent Platform. Your Entire Workforce.

CREW is an AI-native workforce platform: HRMS, recruitment CRM and ATS, attendance with biometric devices, payroll, and workforce intelligence, built as a multi-tenant SaaS with web, Android and iOS clients.

This repository is being built phase by phase. See [docs/architecture](docs/architecture/README.md) for the Phase 0 architecture pack and [docs/phases](docs/phases) for what each phase delivered.

## What works today (Phase 1: foundation)

- Multi-tenant API with PostgreSQL Row-Level Security underneath every query
- Sign-up, sign-in, TOTP MFA, refresh-token rotation, workspace switching, invitations
- Organisation structure: legal entities, business units, locations (with geofences), department tree
- 12 system roles plus custom roles, with RBAC + ABAC scopes (own / team / department / entity / all)
- Tamper-evident audit trail
- Plans, feature entitlements, limits, subscription changes
- SAMPLEDGE Super Admin Console API (tenants, plans, health, support access with customer approval)
- OpenAPI 3.1 spec at `/api/v1/openapi.json` and in [docs/api/openapi.json](docs/api/openapi.json)

## Getting started

Requirements: Node 22, pnpm 10, PostgreSQL 16 (or Docker).

```bash
pnpm install
docker compose -f infra/docker/docker-compose.yml up -d postgres   # or use a local PostgreSQL
cp .env.example .env                                               # fill in the secrets (see comments)
pnpm build:packages
pnpm db:migrate && pnpm db:seed                                    # schema, catalogue, first admin, demo tenant
pnpm dev:api                                                       # http://localhost:4000
```

The demo tenant `demo-northwind` ("Northwind Manufacturing (Demo)") is fictional and flagged as demo data. All its users share `CREW_DEMO_PASSWORD`, for example `owner@demo.crew.local`, `hr.admin@demo.crew.local`, `supervisor@demo.crew.local`, `operator1@demo.crew.local`.

## Tests

```bash
pnpm test        # unit + integration; integration tests create and use a separate crew_test database
```

## Repository layout

See [docs/architecture/12-folder-structure.md](docs/architecture/12-folder-structure.md).
