# Controls map: SOC 2 and ISO/IEC 27001

**CREW is not SOC 2 attested and not ISO/IEC 27001 certified.** No auditor has assessed it. This document is a
readiness aid. It maps the controls built into the product to the criteria an auditor would look at, so the gaps are
visible before anyone starts an audit. Certification covers the organisation that runs CREW, including its people,
processes, hosting and suppliers, not only the code. Most of those organisational controls do not exist yet and are
marked as such below.

References: the SOC 2 rows use the AICPA 2017 Trust Services Criteria (revised points of focus, 2022). The ISO rows
use ISO/IEC 27001:2022 Annex A. The mapping is our own reading of those criteria, not an auditor's.

Status key:

- **Built** means the control is in the product and covered by automated tests or a script in this repository.
- **Partly** means part of it is built and the gap is stated.
- **Not started** means it is an organisational or operational control that the code cannot provide.

## Product controls

| Area | What CREW does | Evidence in this repository | SOC 2 | ISO 27001:2022 | Status |
|---|---|---|---|---|---|
| Workspace isolation | PostgreSQL Row-Level Security forced on every workspace table; the API role cannot bypass it; composite foreign keys stop cross-workspace references | `packages/db/migrations/0001_foundation.sql`, `apps/api/test/tenant-isolation.spec.ts`, the restore check in `packages/db/scripts/dr-drill.ts` | CC6.1 | A.8.3, A.5.15 | Built |
| Authentication | argon2id passwords with lockout; TOTP two-step verification, which a workspace can require for everyone; sensitive permissions need a two-step-verified session | `apps/api/src/platform/auth`, `apps/api/test/auth.spec.ts` | CC6.1 | A.8.5, A.5.17 | Built |
| Single sign-on | OpenID Connect with PKCE, state and nonce; SAML 2.0 with signed assertions, audience, recipient, time and InResponseTo checks; test sign-in before activation; can be enforced, with owners kept as break-glass; the mobile app signs in through a one-time code bound to its PKCE challenge | `apps/api/src/modules/identity/sso.service.ts`, `apps/api/test/enterprise.spec.ts`, `apps/api/test/hardening.spec.ts` | CC6.1 | A.8.5 | Partly: tested against local stubs only, not yet against a real provider |
| Joiner, mover and leaver | Invitations; SCIM 2.0 provisioning and deactivation from the identity provider; deactivation revokes sessions at once; sessions checked on every request | `apps/api/src/modules/identity/scim.service.ts`, `apps/api/test/enterprise.spec.ts` | CC6.2, CC6.3 | A.5.16, A.5.18 | Yes: SCIM Users and Groups; groups grant roles only after an owner maps them (`apps/api/src/modules/identity/scim-groups.service.ts`) |
| Least privilege | Roles with scopes (own, team, department, entity, workspace), checked on every route and filtered in SQL; out-of-scope records return 404 | `apps/api/src/platform/authz`, `apps/api/test/authorization.spec.ts`, `docs/architecture/05-roles-and-permissions.md` | CC6.1, CC6.3 | A.5.15, A.8.2 | Built |
| Privileged and support access | Platform staff are separate from workspace users, with mandatory two-step verification; no customer data without a time-boxed grant the customer approves, which is recorded in the customer's own audit trail | `apps/api/src/modules/platform-admin`, `apps/api/src/modules/support-access`, `apps/api/test/platform.spec.ts` | CC6.1, CC6.2 | A.8.2, A.5.15 | Built |
| Audit trail | Append-only and hash-chained per workspace, written in the same transaction as the change, with a verification endpoint; the chain is re-verified after a restore | `apps/api/src/platform/audit`, `apps/api/test/audit-billing.spec.ts`, `docs/ops/dr-drill-latest.md` | CC7.2, CC4.1 | A.8.15, A.5.28 | Built |
| Encryption | Secrets and sensitive fields encrypted with AES-256-GCM using a key from the environment; tokens and API keys stored as hashes | `apps/api/src/platform/auth/crypto.ts`, `docs/security.md` | CC6.1, CC6.7 | A.8.24 | Partly: one installation key, not per-workspace keys in a key management service; TLS is the hosting's job |
| Secure development | Every input validated; typed contracts shared by web, mobile and API; CI runs typecheck, unit, API and browser tests and checks the API reference is current on every pull request | `.github/workflows/ci.yml`, `packages/contracts` | CC8.1 | A.8.25, A.8.26, A.8.28 | Built |
| Security testing | Automated tests for isolation, authorisation, token tampering and replay; outgoing calls to private addresses refused | `apps/api/test/*.spec.ts`, `apps/api/src/modules/integrations/safe-http.ts` | CC7.1 | A.8.29 | Partly: no independent penetration test yet |
| Outbound connections | Webhooks, Slack and identity provider calls refuse private, loopback and link-local addresses, follow no redirects, time out and cap the response size | `safe-http.ts`, `apps/api/test/integrations.spec.ts` | CC6.6 | A.8.20, A.8.23 | Built |
| Backup and restore | Drill script: full backup, restore into a new database, then checks every table's row count, Row-Level Security, the audit chains and migration history, and records the time taken | `packages/db/scripts/dr-drill.ts`, `docs/ops/dr-drill-latest.md` | A1.2, A1.3 | A.8.13, A.5.30 | Partly: the drill proves the backup format and procedure; production point-in-time recovery and cross-region copies depend on the hosting and are not set up |
| Capacity | Load test against the main read routes with p95 and error-rate thresholds | `e2e/load.cjs`, `docs/ops/load-latest.md` | A1.1 | A.8.6 | Partly: one-machine baseline, not a production capacity test |
| Privacy requests | Access exports and erasure, tracked with a 30-day due date; what is kept, and why, is shown for every request | `apps/api/src/modules/privacy`, `apps/api/test/enterprise.spec.ts` | P5.1, P4.3, C1.2 | A.5.34, A.8.10 | Yes: erasure reaches free text; a retention schedule erases leavers after a set period and deletes old exports and logs (`apps/api/test/hardening.spec.ts`). The periods are the workspace's legal decision |
| Data minimisation in AI | Personal identifiers removed before any model call; pay, bank, tax and health never sent; every call logged; output is a draft a person approves | `apps/api/src/modules/ai`, `apps/api/test/ai-automation.spec.ts` | P4.1, CC6.7 | A.8.11, A.5.34 | Built |
| Immutable records | Raw attendance punches, finalised payroll, released reviews and helpdesk history are protected by database triggers | migrations 0003, 0005, 0006 and 0007, plus the matching tests | PI1.4 | A.5.33 | Built |
| Rate limiting | Per client, stricter on sign-in routes | `apps/api/src/app.module.ts` | CC6.6 | A.8.20 | Yes with `REDIS_URL`: counters shared across API servers, per-server fallback if Redis is down (`apps/api/test/rate-limits.spec.ts`) |
| Secrets | None in code; the API refuses to start with weak or missing keys | `apps/api/src/platform/config`, `.env.example` | CC6.1 | A.8.24, A.5.17 | Built |

## Organisational controls (not provided by the code)

None of these exist yet. Each would have to be in place, and operating for a period, before a SOC 2 Type II report or
ISO 27001 certification is possible.

| Control | SOC 2 | ISO 27001:2022 | Status |
|---|---|---|---|
| Information security policy, roles and an ISMS scope statement | CC1.1 to CC1.5, CC2.1 | Clauses 4 to 6, A.5.1 to A.5.4 | Not started |
| Risk assessment and a risk register reviewed on a schedule | CC3.1 to CC3.4 | Clause 6.1, Clause 8.2 | Not started |
| Staff background checks, security training and confidentiality agreements | CC1.4 | A.6.1 to A.6.6 | Not started |
| Supplier management, covering the hosting, email, AI provider and any identity provider | CC9.2 | A.5.19 to A.5.22 | Not started |
| Incident response plan, on-call rota and customer notification | CC7.3 to CC7.5 | A.5.24 to A.5.27 | Not started |
| Production monitoring and alerting (logs, metrics, uptime) | CC7.2 | A.8.16 | Not started: the API writes structured logs, but nothing collects or alerts on them |
| Business continuity plan with recovery time and recovery point targets agreed with customers | A1.2, A1.3 | A.5.29, A.5.30 | Not started: the drill gives a measured restore time to start from |
| Change approval and segregation of duties for production deployments | CC8.1 | A.8.32 | Partly: pull requests and CI exist; nothing is deployed to production yet |
| Independent penetration test, with findings tracked to closure | CC4.1, CC7.1 | A.8.8, A.8.29 | Not started |
| Asset inventory and device management for staff laptops | CC6.1 | A.5.9, A.8.1 | Not started |
| Data residency per region and a records-of-processing register | P-series, C1.1 | A.5.34 | Not started |
| Internal audit and management review | CC4.1, CC4.2 | Clauses 9.2, 9.3 | Not started |

## Keeping this current

Update a row in the same pull request that changes the control. Re-run the drill and the load test before any audit
and attach the new reports (`pnpm --filter @crew/db dr-drill --report docs/ops/dr-drill-latest.md` and
`node e2e/load.cjs --report docs/ops/load-latest.md`).
