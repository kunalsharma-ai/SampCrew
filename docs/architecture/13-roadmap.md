# 13. Phase-wise Development and Testing Roadmap

Each phase ends with a **phase report** in `docs/phases/` listing: features delivered, tests run and results, security/permission verification, end-to-end workflow demonstrated, and remaining external dependencies (API approvals, hardware, partnerships).

| Phase | Scope | Exit criteria (tests that must pass) |
|---|---|---|
| **0 — Architecture** | This pack | Reviewed by product owner |
| **1 — Foundation** | Monorepo, API, web portal shell, Super Admin Console, PostgreSQL schema + RLS, auth (password, MFA, refresh rotation), tenants, org structure, RBAC/ABAC, audit log (hash-chained), plans/features/subscriptions/entitlements, design system, CI | Cross-tenant isolation tests (API and raw DB), permission matrix tests, auth flow tests, audit chain verification, entitlement gating tests, web build + smoke |
| **2 — Core HRMS** | Employee records (effective-dated), lifecycle events, onboarding checklists, documents (S3, signed URLs), leave types/policies/accrual/requests/approvals, holiday calendars, generic approvals engine, notifications (email), ESS and MSS screens | Leave accrual unit tests, approval-chain tests, document access tests (own/team/tenant), Playwright: hire → onboard → leave request → approve |
| **3 — Attendance and workforce** | Punch API (web, mobile, QR, kiosk), geofencing, attendance engine (late, early, OT, missing punches, breaks), corrections + locks, shifts/rosters/swaps, device hub with adapter framework, ZKTeco/eSSL push adapter + simulator, Go sync agent v1 | Engine golden tests per policy, dedup/idempotency tests, device simulator end-to-end, immutability triggers tested |
| **4 — Recruitment** | Requisitions + approvals, candidate CRM with dedupe/merge, ATS pipeline (drag-and-drop), interviews + scorecards, offers, career pages, job feeds (Google for Jobs structured data, Indeed/XML feeds), resume parsing via AI gateway, recruitment analytics | Pipeline state machine tests, dedupe tests, offer → employee creation E2E |
| **5 — Payroll and finance** | Salary components/structures, compensation, payroll runs, India package (Preview until validated), auditor, approvals, payslips (PDF), bank files, accounting exports, expenses, loans | Golden calculations, decimal precision tests, immutability, reproducibility of finalised payslips |
| **6 — Talent and EX** | Goals/OKRs, reviews, 360, PIPs, learning catalogue/paths, surveys (anonymity thresholds), recognition, internal mobility, helpdesk | Anonymity threshold tests, review cycle workflows |
| **7 — Mobile** | Expo app with employee/manager/recruiter/HR experiences, offline attendance, push, biometric unlock, store readiness | Detox/Maestro flows on Android + iOS simulators, offline sync tests |
| **8 — AI and automation** | AI gateway + providers, copilots, Organisational Memory (RAG with ACL), automation studio (visual + NL-to-workflow), payroll/attendance intelligence, NL reporting | Permission-leak red-team tests for agents, workflow durability tests, AI action logging coverage |
| **9 — Integrations** | Marketplace, OAuth connection framework, Google/Microsoft calendar + mail, Slack/Teams, WhatsApp Business, SMS, accounting, more device adapters, payroll providers, webhooks | Contract tests per connector against sandboxes, retry/backoff tests |
| **10 — Enterprise and global** | SAML/OIDC SSO, SCIM, more country packages, data residency cells, DR drills, performance tuning, pen-test, compliance readiness (SOC 2 / ISO 27001 controls mapping) | Load tests (k6), DR restore drill, external pen-test findings closed |

## Testing strategy

- **Unit**: pure logic (policy engine, accrual, attendance engine, payroll calculators) with Vitest; high coverage required on calculators.
- **Integration**: API module tests against a real PostgreSQL with migrations and RLS applied; each test creates its own tenants.
- **Security**: automated cross-tenant access tests for every new endpoint (a shared helper asserts tenant B can never read or modify tenant A's resource), permission matrix tests generated from the catalogue.
- **E2E**: Playwright against the web portal and console; Maestro for mobile.
- **Non-functional**: k6 load profiles for punch ingestion and payroll runs; axe accessibility checks; dependency and container scanning in CI.
