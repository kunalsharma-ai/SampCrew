# CREW by SAMPLEDGE

> One Intelligent Platform. Your Entire Workforce.

CREW is an AI-native workforce platform: HRMS, recruitment CRM and ATS, attendance with biometric devices, payroll, and workforce intelligence, built as a multi-tenant SaaS with web, Android and iOS clients.

This repository is being built phase by phase. See [docs/architecture](docs/architecture/README.md) for the Phase 0 architecture pack and [docs/phases](docs/phases) for what each phase delivered.

## What works today (Phases 1 to 8)

- Multi-tenant API with PostgreSQL Row-Level Security underneath every query
- Sign-up, sign-in, TOTP MFA, refresh-token rotation, workspace switching, invitations
- Organisation structure: legal entities, business units, locations (with geofences), department tree
- 12 system roles plus custom roles, with RBAC + ABAC scopes (own / team / department / entity / all)
- Tamper-evident audit trail
- Plans, feature entitlements, limits, subscription changes
- **Web Portal** (Next.js, port 3000): sign-up, sign-in with MFA, people and invitations, organisation structure, roles and permissions, audit trail with integrity check, plan and billing, workspace settings, support-access approvals, personal security
- **Super Admin Console** (Next.js, port 3001) for SAMPLEDGE staff: mandatory MFA, metrics, tenants (create, suspend, subscription overrides), plans and prices, system health, platform audit, console admins, and read-only support view only after the customer approves
- **Core HR (Phase 2)**: employee records with effective-dated job history, transfers, probation and exits; onboarding checklists; leave types, policies, holiday calendars, ledger-based balances with idempotent accrual, requests with live preview and year-end close; a multi-step approvals engine; documents with signed download links; in-app notifications and SMTP email. See [docs/phases/phase-2.md](docs/phases/phase-2.md)
- **Attendance and Workforce (Phase 3)**: immutable raw punches with an explainable attendance engine; web punching with geofences; rotating QR kiosks; corrections and overtime through approvals; shifts, rosters and same-day swaps; payroll period locks; ZKTeco and eSSL push devices (Preview) with enrolment mapping, live status and a device simulator. See [docs/phases/phase-3.md](docs/phases/phase-3.md)
- **Recruitment (Phase 4)**: requisitions with approval; a public career site with consented, rate-limited applications and CV checks; a configurable pipeline board with an append-only history; interviews with independent scorecards; offers with an above-budget flag and two-step-verified approval; hiring straight into Core HR; candidate erasure and automatic retention. See [docs/phases/phase-4.md](docs/phases/phase-4.md)
- **Payroll and finance (Phase 5)**: exact-decimal India payroll engine with an explanation for every amount; pay components, salary structures and effective-dated salaries; statutory settings each workspace reviews and saves per legal entity (starting values are not certified); monthly runs with loss of pay from attendance and unpaid leave, adjustments, overrides, approval by someone other than the preparer, and a database-level freeze on finalise; payslips; payroll register and audited bank file; expense claims with receipts, manager approval and reimbursement through payroll. See [docs/phases/phase-5.md](docs/phases/phase-5.md)
- **Performance, learning and engagement (Phase 6)**: goals with key results, check-ins and alignment up the manager chain; review cycles with self and manager reviews, 360 feedback shown to the employee without names and only above a threshold, calibration with recorded reasons, release and acknowledgement, frozen by the database after release; a learning catalogue with paths, assignment, self-enrolment, manager-recorded classroom attendance and expiry; always-anonymous surveys with eNPS and a small-group-safe breakdown; a recognition wall with company values. See [docs/phases/phase-6.md](docs/phases/phase-6.md)
- **Mobile app and HR helpdesk (Phase 7)**: an HR helpdesk with numbered cases, help-article suggestions, auto-assignment, priority-scaled response targets, internal notes, ratings, auto-close and confidential categories that managers never see; announcements with audiences, read receipts and acknowledgements; an Expo app for iOS and Android (employees and managers) with two-step sign-in, fingerprint or face unlock, punching with an offline queue that keeps the original time and flags clock changes, leave, payslips, approvals, Ask HR and announcements; device sign-out and generic push through Expo (off until configured). The app has been tested through its browser build, not yet on phones. See [docs/phases/phase-7.md](docs/phases/phase-7.md)
- **AI copilots, Automation Studio and insights (Phase 8)**: an HR assistant that answers employees only from published help articles with citations, and reply drafts for HR, through one AI gateway with per-workspace switches, monthly credits, removal of personal identifiers before sending and a full call log for auditors (off unless the installation sets `AI_PROVIDER` and a key; only the Claude API is implemented, and it has been tested against a local stub, not a real model yet); Automation Studio with triggers, conditions, notifications, waits, approvals and course assignment, AI-drafted workflows, immutable tested versions, durable runs with retries and a step-by-step trace; a rule-based attrition risk score with named signals for HR only; payroll checks against each person's earlier months before approval. See [docs/phases/phase-8.md](docs/phases/phase-8.md)
- **Integrations (Phase 9)**: workspace API keys with read-only scopes (hashed, shown once, acting as their creator); outgoing webhooks for people, leave, helpdesk and payroll events, signed with HMAC-SHA256, retried six times with a delivery log and redelivery, and blocked from private network addresses; Slack posting from workflows through an incoming webhook (tested against a local stub, not a real Slack workspace yet); "Post to Slack" and "Send to a webhook" workflow steps; an integrations page that marks Teams, Google, Microsoft 365, WhatsApp, SMS, accounting and job boards as planned. See [docs/phases/phase-9.md](docs/phases/phase-9.md)
- **Enterprise readiness (Phase 10)**: OpenID Connect single sign-on (test sign-in before switching on, can be required for everyone with owners kept as break-glass, accounts on first sign-in); SCIM 2.0 user provisioning; privacy requests with a JSON data export and erasure that keeps what the law requires; a backup and restore drill (`pnpm --filter @crew/db dr-drill`), a load test (`pnpm load-test`) and a SOC 2 / ISO 27001 controls map for readiness (no certification). Tested against a local OIDC stub, not a real identity provider yet; no SAML, no mobile single sign-on. See [docs/phases/phase-10.md](docs/phases/phase-10.md)
- **Workspace experience (design refresh, part 1)**: the "Adaptive Human Intelligence OS" design foundation. Twelve theme presets (Midnight Intelligence by default), each with light, dark and system modes and checked for WCAG AA contrast; your own primary, secondary and accent colours; density, text size, corners, contrast, table rows, chart palette, motion (Cinematic, Balanced, Focus) and a Focus mode, all saved per person in the database and applied without a reload on every device. A new shell with a collapsible, searchable sidebar grouped by HR module, favourites, live counters, a Create menu, and a Ctrl+K palette that searches people and candidates and runs actions. Home is now a dashboard with live, permission-scoped KPIs, "Needs your attention" with one-click approvals, workforce charts, recently viewed pages, personal notes and a layout you can rearrange. See [docs/phases/design-1.md](docs/phases/design-1.md)
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

The mobile app is in `apps/mobile` (Expo). Set `EXPO_PUBLIC_CREW_API_URL` to an API address the phone can reach (for example your computer's LAN address and port 4000), then run `pnpm --filter @crew/mobile start` and open it in Expo Go or a development build. Push needs an Expo project (`EAS_PROJECT_ID`) and `EXPO_PUSH_ENABLED=true` on the API. `pnpm --filter @crew/mobile export:web` builds a browser preview into `apps/mobile/dist-web`; its origin must be in the API's `CORS_ORIGINS`.

Sign in to the Web Portal with a demo user (below). Sign in to the console with `CREW_BOOTSTRAP_ADMIN_EMAIL` / `CREW_BOOTSTRAP_ADMIN_PASSWORD` from your `.env`; you will be asked to set up an authenticator app before anything else.

The demo tenant `demo-northwind` ("Northwind Manufacturing (Demo)") is fictional and flagged as demo data. All its users share `CREW_DEMO_PASSWORD`, for example `owner@demo.crew.local`, `hr.admin@demo.crew.local`, `hr.ops@demo.crew.local`, `supervisor@demo.crew.local`, `operator1@demo.crew.local`, `payroll@demo.crew.local`, `finance@demo.crew.local`.

## Tests

```bash
pnpm test           # unit + integration; integration tests create and use a separate crew_test database
pnpm e2e:web        # browser test of the Web Portal (needs a fresh `pnpm db:reset` and running API + web)
pnpm e2e:hr         # Core HR flow: hire, onboard, apply for leave, approve (run after e2e:web, API + web)
pnpm e2e:talent     # Talent flow: goals, review cycle to release, learning, survey, recognition (fresh db, before e2e:recruitment)
pnpm e2e:helpdesk   # Helpdesk and announcements flow: settings, case conversation, confidential grievance, acknowledgement (before e2e:recruitment)
pnpm e2e:attendance # Attendance flow: punch, correct, approve, simulated device, QR kiosk (API + web)
pnpm e2e:recruitment # Recruitment flow: apply on the career site, pipeline, scorecard, offer approval, hire (fresh db, API + web)
pnpm e2e:payroll    # Payroll flow: settings, salaries, expenses, run, approval, payslip (fresh db, API + web)
pnpm e2e:experience # Theme Studio, favourites, palette, Home approvals and layout (before e2e:recruitment)
pnpm e2e:mobile     # Mobile app (browser build) against the API: offline punches, leave approval, Ask HR, two-step sign-in, device sign-out (before e2e:recruitment; build with export:web first)
pnpm e2e:integrations  # API keys, webhooks, Slack and workflow steps with local receivers (fresh db; start the API with INTEGRATIONS_ALLOW_PRIVATE_URLS=true SLACK_WEBHOOK_BASE_URL=http://localhost:4020)
pnpm e2e:ai         # AI, Automation Studio and attrition flow against the local AI test stub (fresh db; start `node e2e/ai-stub.cjs` and the API with AI_PROVIDER=anthropic ANTHROPIC_API_KEY=<any test value> ANTHROPIC_BASE_URL=http://localhost:4010)
pnpm e2e:console    # browser test of the console, including support access across both apps (fresh db, API + web + console)
```

CI runs all of these on every pull request.

## Repository layout

See [docs/architecture/12-folder-structure.md](docs/architecture/12-folder-structure.md).
