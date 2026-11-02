# Phase 11 report: closing the known gaps

Phase 11 closes the gaps Phase 10 listed that needed nothing from outside (no real accounts, keys or hosting):

- **SAML 2.0 single sign-on**, next to OpenID Connect.
- **Single sign-on in the mobile app.**
- **SCIM Groups**, which a workspace owner maps to CREW roles.
- **Erasure that reaches free text**, and a **retention schedule** with a daily run.
- **Rate limits shared across API servers** through Redis.

Permissions are unchanged: single sign-on and SCIM settings need `security:manage` (owners, two-step verification, Enterprise plan); the retention schedule needs `privacy:manage` (owners and HR admins, two-step verification, every plan).

## Working end to end, and not yet

### Working end to end

Each item runs against the real API and PostgreSQL. API tests are in `apps/api/test/hardening.spec.ts` (16 tests) and `apps/api/test/rate-limits.spec.ts` (2 tests); shared rules in `packages/contracts/src/enterprise.spec.ts`; the mobile helpers in `apps/mobile/src/lib/sso.spec.ts`. The browser flow `e2e/hardening-flow.cjs` (CI step "Phase 11 end-to-end flow") covers the Web Portal and the mobile app's browser build.

The identity provider in these tests is a **SAML TEST STUB** (`e2e/saml-stub.cjs`). It reads CREW's real AuthnRequest and answers with a real signed assertion (RSA-SHA256, exclusive canonicalisation) made with a throwaway key, but it signs in whoever the test sets, with no password.

- **SAML 2.0** (Settings, Single sign-on, protocol "SAML 2.0"):
  - The owner copies CREW's entity ID and Assertion Consumer Service URL, or loads the metadata from `GET /api/v1/auth/sso/saml/metadata`, and pastes the provider's entity ID, sign-in URL and signing certificate.
  - CREW reads the certificate on save, refuses one that is invalid or expired, and shows its SHA-256 fingerprint and expiry date (highlighted in the last 30 days). Leaving the certificate blank keeps the stored one.
  - The same rules as OpenID Connect: a test sign-in must pass before switching on, a new certificate, provider or protocol needs a new test, it can be required for everyone, and owners keep their password.
  - Every response is checked: signature against the pasted certificate, audience, recipient, time limits, and that it answers the exact request CREW sent (stored per sign-in, used once). In the API tests six kinds of bad response were refused, each with its reason: signed with another key, wrong audience, answering another request, unsigned, expired, and changed after signing. A replayed response was refused too. In the browser a forged response was refused and the reason shown.
  - The email comes from the NameID or the usual email attributes, and must be in one of the workspace's domains. An authentication context such as Microsoft's `multipleauthn` counts as two-step verification.
- **Single sign-on in the mobile app** ("Sign in with single sign-on" on the app's sign-in screen):
  - The app makes its own PKCE pair, sends only the challenge and its return address, and opens the provider in the system browser (on iOS and Android through `expo-web-browser`).
  - When the provider is done, the Web Portal sends the browser back to the app with a one-time code. The code works once, for two minutes, and only with the app's verifier; it is stored hashed. A wrong verifier is refused and audited, and the code is spent.
  - Only return addresses on the API's `MOBILE_SSO_REDIRECTS` list are accepted (`crew://sso` by default).
  - In the browser flow the app's browser build signed in through the SAML stub and reached its home screen; the spent code was refused afterwards.
- **SCIM Groups** (`/scim/v2/Groups`, and "Groups from your identity provider" in Settings):
  - Create, read, list (filter by `displayName` or `externalId`, `excludedAttributes=members`), replace, patch and delete, in the shapes Okta and Microsoft Entra ID send. Members must be CREW users; unknown ones are refused so the provider shows the problem.
  - A group grants nothing until an owner picks a role for it. The owner role can never be picked.
  - Members hold the role while in the group. Leaving removes the role only if it came from a group and no other group they are in grants it. Roles given by hand in CREW are never removed by a group, and editing someone's roles by hand leaves group roles in place.
  - Every change is in the provisioning log and the audit trail. In the browser flow a pushed group was mapped to Payroll Admin, the member held the role, and lost it when removed from the group.
- **Erasure reaches free text**: besides Phase 10's identity, contact, bank, tax and ID details, documents, helpdesk text and sign-in account, an erasure now blanks expense descriptions, goal titles, descriptions and check-in notes, review answers and comments, feedback about the person, recognition messages written to them, reasons on leave cancellations, attendance corrections and overtime, job-change and course notes, and approval summaries. It deletes their attrition scores, assistant conversations, personal notes, saved views, notifications, drafts and registered phones. Amounts, ratings, dates and statuses stay. Released reviews and other frozen records accept only this change, only inside the erasure; the API test checks the database still refuses anything else.
- **Retention schedule** (Organization, Privacy requests, "Retention schedule"):
  - Automatic erasure of leavers a set number of years after their last working day (off by default), deletion of access exports after a number of days (30 by default) and of sign-in and provisioning logs (90 by default).
  - It runs once a day from the HR jobs, and on demand with "Run now". Each automatic erasure is a privacy request from "Retention schedule", decided by the system, doing exactly what an erasure by HR does. People in a payroll run that is not finalised wait.
  - Each run is listed with what it did. Raw attendance punches, payroll and the audit trail are never deleted by it; the API test checks the punches are untouched.
- **Shared rate limits**: with `REDIS_URL` set, every API server counts against the same limits. The test runs two API instances with their own Redis connections: ten sign-in starts spread across both were answered and the next ones refused on both. If Redis cannot be reached, each server falls back to its own counters and keeps serving; the test checks that too.

### Not yet working, or not yet verified

- **Not tested against real identity providers.** Only the local SAML and OIDC stubs have signed anyone in. Before production, connect a test application in Okta or Microsoft Entra ID, for both protocols, and push a group with SCIM.
- **SAML limits**: CREW's sign-in requests are not signed, encrypted assertions are not supported, and single logout is not implemented (signing out of CREW does not sign out of the provider). CREW trusts the provider's email for the workspace's own domains, because SAML has no "email verified" flag.
- **The mobile app has been tested through its browser build only**, not on iOS or Android devices; the native path uses the system browser through `expo-web-browser` and the `crew://sso` address.
- **Retention periods are the workspace's legal decision.** The defaults are not legal advice, and the page says so.
- **Redis is not part of any hosting yet.** Without `REDIS_URL` each API server counts on its own, which is right only for one server.
- Still not done from earlier lists: data residency cells, an external penetration test, and more country payroll packages.

## What was delivered

- **Database** (`packages/db/migrations/0020_hardening.sql`):
  - `sso_connections` takes SAML (`saml_sso_url`, `saml_idp_cert`, `saml_cert_expires_at`, `saml_cert_fingerprint`), with a check that each protocol has its own fields.
  - `sso_login_states` records the protocol, the mobile return address and the app's challenge; new `sso_handoffs` for one-time mobile codes.
  - New `scim_groups` and `scim_group_members`; `role_assignments.source` (`manual` or `scim`).
  - New `retention_policies` and `retention_runs`; `privacy_requests.export_deleted_at`, the only change allowed to a closed request.
  - The review, feedback and course guards allow the erasure blanking only while `crew.erasure` is on. RLS is forced on every new table.
- **API**:
  - `POST /auth/sso/saml/callback`, `GET /auth/sso/saml/metadata`, `POST /auth/sso/exchange` (public, rate limited); `POST /auth/sso/start` takes `returnTo` and `appChallenge` from the app.
  - `/scim/v2/Groups`; `GET /security/scim/groups` and `PUT /security/scim/groups/:id/role`.
  - `GET` and `PUT /privacy/retention`, `POST /privacy/retention/run`.
  - Library: `@node-saml/node-saml` 5.1.0 for SAML; `@nest-lab/throttler-storage-redis` 1.2.0 and `ioredis` 5.11.1 for shared rate limits.
- **Web Portal**: `/sso/saml` (the SAML ACS, which posts to the API) and a shared finish step for both protocols, including the mobile hand-off; the Settings page with the protocol choice, SAML fields and the groups table; the retention schedule on the Privacy requests page.
- **Mobile app**: single sign-on on the sign-in screen, `/sso` for the browser build, and `src/lib/sso.ts`.
- **Config**: `MOBILE_SSO_REDIRECTS` and `REDIS_URL` (see `.env.example`).

## Tests

- **API**: 324 tests pass (18 new in this phase).
- **Shared rules**: 207 pass. **Mobile**: 22 pass.
- **Browser**: `e2e/hardening-flow.cjs` passes; the Phase 10 enterprise flow still passes.
