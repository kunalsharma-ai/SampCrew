# Security review (Phase 12, November 2026)

An internal review of the whole application before going live: the API, the Web Portal, the Super Admin Console, the
mobile app, the database and the deployment files. It was done by reading the code and configuration and by testing
the running system; it is **not** an external penetration test, which is still needed before production (see the end).

## Method

1. Inventory of every route and how it is protected, from the controllers' own metadata (now a test).
2. Authentication and session handling: token signing and verification, cookies, refresh, MFA, single sign-on.
3. Authorisation and workspace isolation: Row-Level Security, permission checks, the existing isolation tests.
4. Input handling: SQL construction, uploads, downloads, redirects, outbound calls (SSRF).
5. Browser security: headers, Content Security Policy, third-party requests.
6. Configuration and secrets: what the API accepts in production, what the images contain.
7. Availability under load and failure: overlapping writes, database outages, several API servers.
8. Dependencies: `pnpm audit --prod`.

## Findings and what was done

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | **Open redirect after sign-in.** `/login?next=/\evil.example` passed the "starts with one slash" check, and browsers read the backslash as a slash, so a crafted link could send someone to another site right after they signed in (a phishing aid). Web Portal and Console. | Medium | Fixed: `safeNextPath` in `@crew/contracts`, unit tests, and checked in the deployment smoke test. |
| 2 | **Overlapping writes failed with "deadlock detected".** The audit trail's per-workspace chain lock was taken in the middle of each transaction; two requests touching the same rows in a different order (a leave approval and a leave application, two helpdesk updates) waited on each other and PostgreSQL failed one with a 500. Found by the new workflow load test: 15 failed requests in 15 seconds at 12 concurrent workflows, 14 of them deadlocks. | High (availability, data entry lost) | Fixed: the audit row is written just before commit (`deferUntilCommit`), so the chain lock is always taken last. Same run afterwards: 0 errors in 1,956 requests, and p95 latency fell. Regression test reproduces the lock order. |
| 3 | **A database blip could stop the API process.** The outbox and email loops did not catch errors, so an unreachable database (restart, failover, restore) raised an unhandled rejection and Node exited. | High (availability) | Fixed: both loops log and retry on the next tick; test. `/health/ready` now answers 503 (not 500) while the database is unreachable, so load balancers wait instead of failing over. |
| 4 | **Production could start with unsafe settings.** Plain-http public URLs (session cookies and tokens over the network unencrypted), localhost or wildcard CORS origins, `http://` mobile sign-in return addresses, and template secrets such as `change-me` were all accepted with `CREW_ENV=production`. | High | Fixed: the API refuses to start in staging or production and lists every problem at once; the seed refuses demo data and short bootstrap passwords in production. Tests. |
| 5 | **Daily HR jobs ran on every API server.** With two or more servers each ran accruals, exits and retention for every workspace at the same time. Unique keys prevented most duplicates, but the work and the lock contention doubled. | Medium | Fixed: a database session lock lets one server run them at a time; test. (Queues such as the outbox, email, webhooks and workflows already claimed work with `skip locked`.) |
| 6 | **No Content Security Policy** on the Web Portal or Console. | Medium | Fixed: scripts, styles, fonts, frames and connections only from CREW itself; `object-src 'none'`, `base-uri 'self'`, `frame-ancestors`. Inline scripts are still allowed because Next.js needs them (see open items). Every browser flow in CI runs with it. |
| 7 | **Every page view sent visitors' IP addresses to Google** (Google Fonts), a personal-data transfer to a third party without a stated basis. | Medium (privacy) | Fixed: fonts are bundled and served by CREW (`@fontsource`). |
| 8 | **Downloads of files with non-English names failed** (`Invalid character in header content`), and uploads replaced every non-ASCII letter with `_`, so "वेतन पर्ची.pdf" became "_ _.pdf". | Medium (integrity of HR records, availability) | Fixed: names are kept in every language, with only path and header characters removed; downloads send an RFC 6266 `filename*`. Unit and API tests. |
| 9 | **Known vulnerabilities in dependencies.** nodemailer 6.10 (several advisories, high), zod 4.1 (high), fflate 0.8.2 (moderate). | High | Fixed: nodemailer 8.0.11, zod 4.6.7, fflate 0.8.3. See open items for the ones not yet fixable. |
| 10 | **Email addresses in API logs** (failed email deliveries). | Low (privacy) | Fixed: logs name the message id only. |
| 11 | No test stopped a new route from being public by accident. | Low | Fixed: a test lists every route reachable without signing in (31 today, each reviewed); a new one fails the build until it is reviewed. |

## Checked and found sound

- **Tokens**: access tokens are HS256 with the algorithm pinned, issuer and audience checked, 15 minutes by default;
  refresh tokens rotate and reuse revokes the whole family; console tokens use a separate secret and audience. A
  forged or unsigned token is refused (test).
- **Cookies**: `HttpOnly`, `Secure` (unless explicitly turned off for local http), `SameSite=Lax`; checked over TLS in
  the deployment smoke test.
- **CSRF**: the API takes bearer tokens only (no cookies, `credentials: false` in CORS); the Web Portal's server
  actions check the request origin (Next.js).
- **Workspace isolation**: PostgreSQL Row-Level Security is enabled and forced on every table with a `tenant_id`, and
  the API connects as a role that cannot bypass it; `tenant-isolation.spec.ts` and the restore check verify it.
- **SQL**: values are always bound parameters; the few dynamic column lists and sort orders come from fixed maps or
  enums validated by zod.
- **Uploads**: size limits, content sniffing against the declared type, storage paths resolved inside the storage
  root, downloads only through short-lived HMAC-signed links.
- **Outbound calls**: webhooks, Slack and identity-provider addresses refuse private and loopback networks outside
  local development.
- **Errors**: responses never include stack traces or database messages; every error carries a request id.
- **Passwords and MFA**: Argon2 hashes, TOTP with replay protection, rate-limited sign-in; MFA required for the
  Console and for payroll and security settings.
- **Images**: run as non-root users, contain no secrets, and read all configuration from the environment.

## Open items (not fixed in this phase)

- ~~multer 2.x before 2.5 (via NestJS)~~: fixed on 5 November 2026 with a `multer: 2.5.0` override in
  `pnpm-workspace.yaml`, once 2.5.0 was two weeks old.
- **Build and mobile tooling advisories**: postcss inside Next.js (build time only, processes CREW's own CSS),
  glob, minimatch and deepmerge inside the Expo CLI (developer tooling, not shipped), decode-uri-component inside
  expo-router (patched 0.5.1 released 23 October 2026; due from 6 November 2026).
- ~~Content Security Policy with nonces~~, ~~field encryption key rotation~~ and ~~malware scanning of uploads~~:
  done in Phase 13 (`docs/phases/phase-13.md`).
- **External penetration test** by an independent firm, and single sign-on and SCIM against real identity providers.
