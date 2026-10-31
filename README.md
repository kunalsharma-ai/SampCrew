# CREW by SAMPLEDGE

> One Intelligent Platform. Your Entire Workforce.

CREW is an AI-native workforce platform: HRMS, recruitment CRM and ATS, attendance with biometric devices, payroll, and workforce intelligence, built as a multi-tenant SaaS with web, Android and iOS clients.

This repository is being built phase by phase. See [docs/architecture](docs/architecture/README.md) for the Phase 0 architecture pack and [docs/phases](docs/phases) for what each phase delivered.

## What works today (Phases 1 and 2: foundation and Core HR)

- Multi-tenant API with PostgreSQL Row-Level Security underneath every query
- Sign-up, sign-in, TOTP MFA, refresh-token rotation, workspace switching, invitations
- Organisation structure: legal entities, business units, locations (with geofences), department tree
- 12 system roles plus custom roles, with RBAC + ABAC scopes (own / team / department / entity / all)
- Tamper-evident audit trail
- Plans, feature entitlements, limits, subscription changes
- **Web Portal** (Next.js, port 3000): sign-up, sign-in with MFA, people and invitations, organisation structure, roles and permissions, audit trail with integrity check, plan and billing, workspace settings, support-access approvals, personal security
- **Super Admin Console** (Next.js, port 3001) for SAMPLEDGE staff: mandatory MFA, metrics, tenants (create, suspend, subscription overrides), plans and prices, system health, platform audit, console admins, and read-only support view only after the customer approves
- **Core HR (Phase 2)**: employee records with effective-dated job history, transfers, probation and exits; onboarding checklists; leave types, policies, holiday calendars, ledger-based balances with idempotent accrual, requests with live preview and year-end close; a multi-step approvals engine; documents with signed download links; in-app notifications and SMTP email. See [docs/phases/phase-2.md](docs/phases/phase-2.md)
- OpenAPI 3.1 spec at `/api/v1/openapi.json` and in [docs/api/openapi.json](docs/api/openapi.json)

Not connected yet, and labelled as such in the product: payment collection (invoices are issued manually by SAMPLEDGE finance), Redis, and S3-compatible object storage (files use local disk). Email is sent only when `SMTP_URL` is set; otherwise it is recorded as skipped, and invitation links are shown on screen in local environments.

## Getting started

Requirements: Node 22, pnpm 10, PostgreSQL 16 (or Docker).

```bash
pnpm install
docker compose -f infra/docker/docker-compose.yml up -d postgres   # or use a local PostgreSQL
cp .env.example .env                                               # fill in the secrets (see comments)
pnpm build:packages
pnpm db:migrate && pnpm db:seed                                    # schema, catalogue, first admin, demo tenant
pnpm dev:api                                                       # API on http://localhost:4000
pnpm dev:web                                                       # Web Portal on http://localhost:3000
pnpm dev:console                                                   # Super Admin Console on http://localhost:3001
```

Sign in to the Web Portal with a demo user (below). Sign in to the console with `CREW_BOOTSTRAP_ADMIN_EMAIL` / `CREW_BOOTSTRAP_ADMIN_PASSWORD` from your `.env`; you will be asked to set up an authenticator app before anything else.

The demo tenant `demo-northwind` ("Northwind Manufacturing (Demo)") is fictional and flagged as demo data. All its users share `CREW_DEMO_PASSWORD`, for example `owner@demo.crew.local`, `hr.admin@demo.crew.local`, `supervisor@demo.crew.local`, `operator1@demo.crew.local`.

## Tests

```bash
pnpm test           # unit + integration; integration tests create and use a separate crew_test database
pnpm e2e:web        # browser test of the Web Portal (needs a fresh `pnpm db:reset` and running API + web)
pnpm e2e:hr         # Core HR flow: hire, onboard, apply for leave, approve (run after e2e:web, API + web)
pnpm e2e:console    # browser test of the console, including support access across both apps (fresh db, API + web + console)
```

CI runs all of these on every pull request.

## Repository layout

See [docs/architecture/12-folder-structure.md](docs/architecture/12-folder-structure.md).
