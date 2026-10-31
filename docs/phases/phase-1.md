# Phase 1 report: Foundation

Status: complete, pending product owner review.
Date: 2026-10-31.

## What was delivered

### Platform and data
- A pnpm monorepo with these parts:
  - `apps/api`: NestJS 11
  - `apps/web`: the Web Portal (Next.js 15)
  - `apps/console`: the Super Admin Console (Next.js 15)
  - Shared packages: `contracts`, `db` and `ui`
- PostgreSQL 16 schema in numbered, checksummed SQL migrations:
  - Row-Level Security is forced on every tenant table.
  - Foreign keys are composite `(tenant_id, id)`, so rows cannot reference another tenant.
  - Column grants hide password hashes and MFA secrets from the application role.
  - Three database roles separate tenant access, platform access and the login role.
- The audit trail is append-only and hash-chained per tenant, with a verification function. It is written in the same transaction as the change it records.
- A transactional outbox for domain events, with a dispatcher.
- Catalogue sync covers permissions, features and plans. Tenant provisioning and a fictional demo workspace ("Northwind Manufacturing (Demo)") are clearly flagged as demo data in the UI and the database.

### Identity and access
Accounts:
- Sign-up creates the workspace, the owner and a trial subscription.
- Passwords use argon2id, and accounts lock after repeated failures.
- TOTP MFA secrets are encrypted at rest.
- Access tokens are short-lived and bound to server-side sessions.
- Refresh tokens rotate, and reuse of an old one revokes the whole session family.
- Users can be in several workspaces, with a workspace picker.
- Invitations are covered.

Authorisation:
- There are 12 system roles plus custom roles. The ABAC policy engine supports the scopes own, team, department, entity and tenant.
- Role assignments can be constrained by entity, department and location.
- MFA-gated permissions exist.
- Scope is pushed down into SQL for lists.
- Out-of-scope records return 404.

Plans and entitlements:
- There are four plans with feature flags and limits.
- Subscription changes are validated against current usage.
- Platform feature overrides are supported.

The Super Admin realm uses separate tokens, sessions and secrets, and MFA is mandatory.

Support access:
- SAMPLEDGE staff see customer HR data only through a time-boxed grant that the customer approves.
- Every view is written to the customer's own audit trail.

### Web Portal (port 3000)
| Area | Pages |
|---|---|
| Sign-in | Sign-in with MFA and workspace picker; sign-up; accept invitation |
| Home | Workspace stats, setup checklist, "your access" summary, plan card |
| People | List and search, invite with roles and placement, change placement and roles, resend invite, suspend |
| Organisation | Legal entities, locations (with geofence fields), departments (tree), business units: create, edit, archive |
| Admin settings | Roles and permissions (system roles read-only, custom role editor); audit trail with filters and integrity check; plan and billing; workspace settings (including the MFA requirement); support-access approvals |
| You | Security: MFA enrolment, password change, active sessions |

Other behaviour:
- Navigation is driven by the user's effective permissions and plan features.
- Opening a page without access shows a "no access" page that gives the reason, such as missing permission, MFA needed or not in plan.
- Tokens live only in httpOnly cookies. Middleware refreshes them, and every mutation runs through a server action.

### Super Admin Console (port 3001)
- Every page requires MFA enrolment first.
- Overview: tenants, sign-ups, MRR at list price excluding demo and trial workspaces, trials ending, and subscriptions by plan.
- Tenants:
  - List, search and create (sales-assisted onboarding with an owner invitation).
  - Detail view with suspend or reactivate (a reason is required).
  - Subscription override: plan, status, seats, trial end and per-feature overrides.
  - Support-access requests, and the read-only support view while a grant is active.
- Plans and prices, with decimal validation.
- System health, including which services are not configured.
- Platform audit log.
- Console admins: create an admin with a role. New admins must enrol MFA at first sign-in.

### Design system
`@crew/ui` provides the shared components:
- Colour tokens with light and dark themes.
- Button, form fields with ARIA wiring, cards, badges, stats, tables, alerts, empty states, a dialog on the native `<dialog>` element, and the logo and demo banner.

The Web Portal and the console both use it.

## Tests

| Suite | Count | Covers |
|---|---|---|
| Contracts unit tests | 10 | Permission catalogue integrity, role segregation (auditor, payroll), plans, schemas, PATCH schema helper |
| Policy engine unit tests | 9 | Every scope, constraints, MFA conditions, SQL predicates |
| Tenant isolation (raw DB + API) | 19 | RLS read/write/update/delete across tenants, no-context reads, role grants, hidden columns, composite FKs, API by-id, lists, cross-tenant references, token replay |
| Authentication | 9 | Sign-up, duplicates, validation, lockout, refresh rotation and reuse detection, logout, MFA, workspace picker, invitations |
| Authorisation | 10 | Own/team/entity scopes, 404 on out-of-scope, scoped writes, auditor read-only, escalation and last-owner guards, suspension |
| Audit, billing, idempotency | 9 | Diffs in the same transaction, no event on failure, append-only, tamper detection, redaction, feature gating, downgrade guard, overrides, idempotent retries |
| Organisation updates | 2 | PATCH does not reset omitted fields; unknown fields and cross-field rules rejected |
| Platform | 8 | Realm separation, forced MFA, tenant admin, suspension, support access with approval and expiry, health, OpenAPI coverage |
| Web Portal browser test (`e2e/web-smoke.cjs`) | 1 flow | MFA enrolment, settings, plan change, downgrade guard, location create and rename, audit verify, MFA sign-in with a wrong code, invite and accept, recruiter blocked from billing |
| Console browser test (`e2e/console-smoke.cjs`) | 1 flow | Forced MFA enrolment, every page, create tenant, subscription override, suspend and reactivate, price change, support access across both apps (request, locked, approve in Web Portal, view, customer audit trail, revoke) |

Results:
- 76 unit and integration tests pass.
- Both browser flows pass against a freshly reset database.
- CI runs all of them, plus the type checks, the production builds and an OpenAPI drift check.

### Defects found and fixed during this phase
- A tenant-scoped request could see the same user's memberships in other tenants through RLS. The policy now allows cross-tenant membership reads only outside a tenant context.
- A PATCH to a legal entity or location silently reset `fiscalYearStartMonth` or `kind` to their defaults when they were left out. A shared `patchOf()` schema helper now strips defaults, and a regression test covers it.
- A wrong MFA code or password on the sign-in page was treated as an ended session and sent the user back to an empty form. Now only requests that carried a session token can end a session.
- Typing the URL of a page the user cannot access showed a server error. It now shows a "no access" page with the reason.

## Security verification
- Tenant isolation is enforced in the database (RLS) and checked again in the API. Tests cover both layers.
- Each protected endpoint declares its permission, or its platform capability for console routes. The OpenAPI test checks that every route is documented.
- No credentials are committed. `.env.example` documents every variable, and CI uses throwaway values.
- Invitation links are shown on screen only in local environments. Production-like environments never return them.
- Console cookies are separate from the Web Portal's (`SameSite=Strict`, 12-hour maximum), and the console sends `noindex` headers.

## Not connected yet (and shown as such in the product)
- Email delivery: Phase 2.
- Payment collection (Stripe or Razorpay): needs merchant accounts. Invoices are issued manually by SAMPLEDGE finance.
- Redis, object storage, error tracking: listed under "Not configured" on the console health page.
- SSO and SCIM: Phase 10.

## External dependencies for later phases
- Merchant accounts for payment providers.
- An email sending domain with SPF, DKIM and DMARC.
- Biometric device SDK or API documentation from vendors for Phase 3.
- Job board partner programmes for Phase 4.
- Statutory payroll rules validated by a qualified Indian payroll professional before payroll leaves "Preview" in Phase 5.

## Next: Phase 2 (Core HRMS)
- Effective-dated employee records and lifecycle events.
- Onboarding checklists.
- Documents in object storage with signed URLs.
- Leave types, policies, accrual, requests and approvals.
- Holiday calendars.
- A generic approvals engine.
- Email notifications.
- Employee and manager self-service screens.
