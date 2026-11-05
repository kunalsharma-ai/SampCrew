# Phase 10 report: enterprise readiness

Phase 10 adds what larger customers and their security reviewers ask for:

- **Single sign-on with OpenID Connect**, so people sign in through the company's identity provider (for example Microsoft Entra ID, Okta or Google Workspace). The owner can require it for everyone.
- **SCIM 2.0 user provisioning**, so the identity provider creates, updates and deactivates CREW accounts.
- **Privacy requests**: HR logs a person's request for a copy of their data, or for erasure, and completes it in CREW with a 30-day due date.
- **A backup and restore drill**, a **load test** with thresholds, and the performance fix the load test found.
- **A controls map** against SOC 2 and ISO/IEC 27001, for readiness only. CREW holds neither.

Plan feature: `sso` (Enterprise only, set by SAMPLEDGE in the console because Enterprise is quote-only). Permissions:

- `security:manage`: workspace owners only, needs two-step verification.
- `privacy:manage`: owners and HR admins, needs two-step verification, on every plan because answering these requests is a legal duty.

## Working end to end, and not yet

### Working end to end

Each item below runs against the real API and PostgreSQL and is covered by API tests (`apps/api/test/enterprise.spec.ts`, 14 tests). The browser flow `e2e/enterprise-flow.cjs` also covers it. The identity provider in these tests is an **OIDC TEST STUB** (`e2e/oidc-stub.cjs`) that stands in for a real one. It signs real RS256 ID tokens and checks PKCE and the client secret, but it signs in whoever the test sets, with no password.

- **Connecting a provider** (Settings, Single sign-on):
  - The owner copies the redirect URI, then enters the issuer, client ID, client secret and the workspace's email domains. CREW reads the provider's discovery document before saving.
  - A domain can belong to one workspace only, and the secret is stored encrypted and never shown again.
  - Changing the issuer or client puts the connection back to "not switched on".
- **Test, then switch on**:
  - Switching on is refused until a test sign-in passes. The test goes to the provider and back without signing anyone in, and records who passed it and when.
  - In the browser flow the test used PKCE (S256) and the registered redirect URI.
- **Signing in** ("Sign in with single sign-on" on the sign-in page):
  - The work email picks the workspace by domain and is passed to the provider as a hint.
  - CREW checks state and nonce, which are single-use and expire after 10 minutes, then the ID token's signature against the provider's published keys, and the exact issuer, audience, algorithm and age.
  - The email must be verified and its domain one of the workspace's.
  - If the provider reports a second factor (`amr` with `mfa`, `otp`, `hwk` and similar), the session counts as two-step verified, so HR could open privacy requests straight away.
- **Refusals with a reason**: a tampered token (wrong nonce) was refused in the browser and the reason shown. API tests also cover a bad signature, the wrong audience, a replayed state, an unverified email and a domain the workspace does not own. Every failure is in the workspace's audit trail as `auth.sso_failed`.
- **New people**: with "Create accounts on first sign-in", someone the provider signs in who has no account gets one with the Employee role only, within the seat limit.
- **Requiring it**:
  - Everyone except owners is signed out and must use the provider. In the browser flow the new person's open session ended at once.
  - A member's password attempt turns into the single sign-on step, with their email carried over.
  - Owners keep their password as a way back in if the provider is down.
- **SCIM**:
  - The owner creates a token, which is shown once and stored as a hash, and copies the base URL.
  - In the browser flow the "provider" (the test script) created a person, found them with a `userName eq` filter, deactivated them with PATCH, and was refused with a wrong token. Every call showed in the provisioning log.
  - Deactivation suspends the membership and revokes sessions at once. Owners cannot be deactivated through SCIM.
  - API tests also cover replace, delete, a duplicate userName (409), linking to an existing employee by work email, and another workspace's token seeing nothing.
- **Privacy requests** (Organization, Privacy requests):
  - HR logs who asked and how; the request is due in 30 days and overdue ones are flagged.
  - For an access request, "Prepare export" collects every record linked to the person across all modules into one JSON file. Passwords, keys, tokens and encrypted numbers are left out; bank, tax and ID numbers show only whether one is on file. The file is stored with its SHA-256.
  - In the browser flow HR downloaded the export through the web server. The file held the person and no secrets, and every download is audited.
  - An erasure request for someone still employed shows why it cannot be done, offers no erase button, and was closed as rejected with a reason.
  - API tests cover an erasure end to end, for someone past their last working day:
    - Erased: name, code, contact details, bank, tax and ID numbers, documents and their files, helpdesk text, leave reasons, earlier export files, and the sign-in account (anonymised and disabled when it belongs to no other workspace).
    - Kept, against the pseudonymous record: payroll, attendance and the audit trail.
    - Refused while a payroll run including the person is not finalised.
- **Backup and restore drill** (`pnpm --filter @crew/db dr-drill --report docs/ops/dr-drill-latest.md`):
  - Takes a full `pg_dump`, restores it into a new database, then checks every table's row count, Row-Level Security forced on every workspace table, every workspace's audit hash chain, and the migration history. It records the time taken.
  - Last run: 133 tables and 1,520 rows matched; RLS forced everywhere; chains intact; 10 migrations; backup plus restore 2.2 s on demo data.
- **Load test** (`pnpm load-test --report docs/ops/load-latest.md`):
  - 20 requests in flight for 20 s across 9 read routes the Web Portal and the mobile app call on every screen, as three signed-in demo users.
  - Fails if p95 is over 300 ms or errors are over 1%.
  - The first run failed: the team attendance view rewrote every person's day on every request, and under load those writes queued (p95 2.3 s). It now reuses a day computed in the last 30 seconds, unless a leave request changed since. Punches, corrections and devices already recompute their own days. The employee's "today" view uses the same rule.
  - Last run: 0 errors, p95 221 ms overall, team view p95 183 ms (from 2,278 ms).
- **Controls map**: `docs/compliance/controls-map.md` lists each product control with its evidence in this repository and the SOC 2 criteria and ISO 27001:2022 Annex A controls it relates to. A second table lists the organisational controls that do not exist yet.

### Not yet working, or not yet verified

- **Not tested against a real identity provider.** Only the stub has signed anyone in. CREW uses standard OpenID Connect (discovery, authorization code with PKCE, `client_secret_basic` or `client_secret_post`, RS256/ES256 and similar signatures). Before production, connect a test application in Microsoft Entra ID or Okta and run the test sign-in.
- **No SAML.** Some identity providers and older setups offer only SAML. It is not built, and the settings page says so.
- **No single sign-on in the mobile app.** While single sign-on is required, members cannot sign in on mobile with a password and have to use the web. The settings page says so.
- **SCIM Groups are not supported**, so roles are still managed in CREW. Changing someone's email through SCIM is refused, because email is the sign-in identity.
- **Erasure does not reach free text other people wrote**: expense descriptions, goals, review comments and similar. HR is told to check those by hand. Retention schedules exist only for recruitment and AI logs.
- **The 30-day due date is a default, not legal advice.** Deadlines differ by law (for example GDPR and India's DPDP Act and Rules), and the page tells HR to check with their legal adviser.
- **The drill proves the backup format and the restore procedure only.** Production point-in-time recovery, cross-region copies and the recovery time and recovery point targets depend on the hosting, which is not set up yet.
- **The load test is a one-machine baseline**: the API, database and load generator share 4 cores. It catches regressions and is not a statement of production capacity. Rate limits are in memory per API instance, so Redis is needed before running more than one replica.
- **No external penetration test, no data residency cells, no more country payroll packages.** These were on the Phase 10 roadmap and are not done. A penetration test has to be done by an independent firm against a deployed environment.
- **No certification.** CREW is not SOC 2 attested or ISO 27001 certified, and most organisational controls (policies, risk register, incident response, supplier reviews, monitoring) do not exist yet.

## What was delivered

- **Database** (`packages/db/migrations/0010_enterprise.sql`):
  - New tables: `sso_connections`, `sso_domains` (one workspace per domain), `sso_login_states`, `scim_tokens`, `scim_events` and `privacy_requests`.
  - Closed requests are frozen by a trigger.
  - `memberships` gained `scim_external_id` and `provisioned_by`, and `employees` gained `erased_at`.
  - The helpdesk guard allows the erasure redaction only. RLS is forced on every new table.
- **API**:
  - `modules/identity` (SSO, SCIM and the settings routes) and `modules/privacy`.
  - Public `POST /auth/sso/start` and `POST /auth/sso/callback`, rate limited.
  - The `scim/v2` routes: ServiceProviderConfig, ResourceTypes and Users. They return SCIM-format errors and accept `application/scim+json`.
  - Outgoing calls to the provider reuse the integrations guard (no private addresses unless allowed for tests, no redirects, timeouts, size caps).
- **Web Portal**:
  - A "Sign in with single sign-on" step on the sign-in page.
  - `/sso/callback`, which sets the session in httpOnly cookies. Failure reasons go in a one-minute httpOnly cookie, not the URL, so nobody can craft a link that shows their text on the sign-in page.
  - Settings, Single sign-on and provisioning.
  - Organization, Privacy requests, with the request detail and the export download.
- **Fix found while building the web screens**: the single sign-on routes had also been registered under `/me/sso/*` by mistake. That copy is removed.
- **Ops**: `packages/db/scripts/dr-drill.ts`, `e2e/load.cjs`, `docs/ops/`, `docs/compliance/controls-map.md`.

## Tests

- **API**: `apps/api/test/enterprise.spec.ts` (14 tests) and a new attendance test for the 30-second reuse. The whole suite passes.
- **Shared rules**: `packages/contracts/src/enterprise.spec.ts`.
- **Browser**: `e2e/enterprise-flow.cjs`, added to CI as its own step with a fresh database.
