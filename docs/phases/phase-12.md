# Phase 12 report: ready for production

Phase 12 gets CREW ready to run in production, and needs nothing from outside to do it. It covers:

- A **security review** of the whole application, with every finding that could be fixed now fixed and tested.
- **Load tests on the main workflows**, under concurrency.
- An **accessibility pass**.
- **Deployment files and a runbook**. Going live needs only a host, DNS names, an SMTP account and real keys.

Details: [`docs/security-review.md`](../security-review.md), [`docs/ops/runbook.md`](../ops/runbook.md),
[`docs/ops/load-workflows-latest.md`](../ops/load-workflows-latest.md), [`docs/ops/a11y-latest.md`](../ops/a11y-latest.md).

## Working end to end, and not yet

### Working end to end

- **Production stack** (`infra/deploy/compose.yml`, one Dockerfile in `infra/docker/` with targets `api`, `web`, `console` and `tools`):
  - Caddy terminates TLS with automatic certificates. It adds HSTS, drops the server banners, limits request bodies to 12 MB, and shows the Console only to `CONSOLE_ALLOWED_IPS`.
  - Before the API starts, a one-shot `migrate` job applies migrations and creates the first Super Admin.
  - The database and Redis sit on an internal network the proxy cannot reach.
  - Every image runs as a non-root user and has a health check. No secret is baked in.
  - `gen-secrets.sh` makes fresh secrets, and `env.production.example` is the template.
  - **Verified** by `infra/deploy/smoke.sh`, which runs locally and as the new CI job `deploy`. It builds the images, starts the whole stack over TLS, and waits for every health check. Then, from outside, `e2e/deploy-smoke.cjs` checks:
    - HSTS, `nosniff`, the CSP, no server banners, and that cross-site CORS is refused;
    - sign-in through the browser, with `Secure` and `HttpOnly` cookies;
    - the main pages, the self-hosted fonts, the open-redirect guard, no browser console or CSP errors, and that the Console is reachable.

    After that it takes an encrypted backup, restores it into an empty database, and verifies it: 155 tables, Row-Level Security on every workspace table, every audit chain intact, and employee counts matching.
- **Backups**: the `backup` service writes a `pg_dump` and a tar of uploaded files on a schedule, encrypts both (AES-256-GCM, with a key derived from `BACKUP_PASSPHRASE` by scrypt), and prunes old ones. A changed or truncated backup refuses to decrypt (tested). `restore.sh` refuses to overwrite a database that has data, recreates the roles, restores, migrates, and verifies RLS and the audit chains.
- **Security review**: 11 findings, all fixed with tests. The highest ones were:
  - an **open redirect after sign-in** (`/login?next=/\evil.example`);
  - **deadlocks** under concurrent writes;
  - a **database blip that could stop the API process**;
  - **production starting with unsafe settings**;
  - **daily HR jobs running on every API server**;
  - **known vulnerable dependencies** (nodemailer, zod, fflate).

  The others: no CSP, Google Fonts sending visitors' IP addresses to Google, downloads failing on non-English file names, email addresses in logs, and no guard against a route becoming public by accident. A test now lists all 31 public routes, and a new one fails the build until someone reviews it.
- **Production configuration guard**: in staging or production the API refuses to start, and lists every problem at once, if it finds any of these:
  - plain-http public URLs;
  - localhost or wildcard CORS origins;
  - `http://` mobile return addresses;
  - template secrets, or placeholder database or Redis passwords.

  In production the seed refuses demo data and short bootstrap passwords.
- **Workflow load test** (`pnpm load-test:workflows`, also run in CI for 30 seconds):
  - It hired 200 people through the API in 4.9 s, assigned their salaries in 1.1 s, and computed payroll for 216 payslips in 5.0 s.
  - It then ran 12 concurrent workflows (punch; leave through the full approval chain; helpdesk raise, reply, resolve and confirm; reads) for 60 s: 10,343 requests at 172 per second, **0 errors and 0 deadlocks**. Workflow p95: punch 277 ms, leave 404 ms, helpdesk 352 ms, reads 163 ms.
  - Before the fixes, the same test failed 15 requests in 15 seconds, 14 of them deadlocks. They were fixed by writing the audit row just before commit, and by making a single person's attendance recompute wait for a bulk recompute.
- **Accessibility** (`pnpm e2e:a11y`, also a CI step): axe-core WCAG 2.1 A and AA rules, in the light and the dark theme:
  - 25 screens: the Web Portal signed out, as HR and as an employee; the Console sign-in; the mobile app's browser build.
  - The first run found 48 serious violations, and **0 remain**.
  - The fixes were contrast of secondary text, accent and status colours (the custom theme builder now enforces 4.5:1 for these too), danger buttons, the notification badge, progress bars without names, and the password field's autocomplete on mobile.
- **Health checks**: `/api/v1/health/ready` now answers 503 while the database is unreachable, so a load balancer waits instead of failing over. The web and console have `/healthz` (and `?ready=1` on web, which checks the API).

### Not yet working, or not yet verified

- **No real host has been used.** Everything was verified on one machine with `tls internal` certificates. Automatic Let's Encrypt certificates need real DNS names pointing at a host.
- **No external penetration test.** This was an internal review by reading code and testing the running system. An independent test is still needed before real customer data goes in.
- **Dependency advisories not yet fixable** under the two-week rule for new versions:
  - multer 2.5.0 (inside NestJS, uploads), due from 5 November 2026;
  - decode-uri-component 0.5.1 (inside expo-router), due from 6 November 2026.

  Advisories in build-time and Expo CLI tooling (postcss, glob, minimatch, deepmerge) do not ship in the product.
- **The CSP still allows inline scripts**, because Next.js needs them. Removing that needs per-request nonces.
- **`FIELD_ENCRYPTION_KEY` cannot be rotated yet**: there is no re-encryption job, and the runbook says not to change it.
- **No malware scanning of uploads.** The content type is checked, but contents are not scanned.
- **Load numbers come from one 4-core machine** with the API, database and load generator together. Measure again on production hardware.
- **Accessibility** is automated rules only. These catch roughly a third to half of problems, so keyboard and screen-reader passes by people are still needed. The Console was checked at sign-in only, because its pages need two-step verification.
- **Mobile store builds** (iOS and Android binaries) and push notifications still need Expo and store accounts. The mobile app was checked through its browser build.

## What was delivered

- `infra/docker/Dockerfile`, `.dockerignore`.
- `infra/deploy/`:
  - `compose.yml`, `compose.smoke.yml`, `Caddyfile`, `env.production.example`, `gen-secrets.sh`, `smoke.sh`;
  - `scripts/` (`migrate.sh`, `backup.sh`, `restore.sh`, `crypt.mjs`).
- API:
  - `deferUntilCommit` in the database service (audit rows written at commit);
  - shared attendance lock for single recomputes;
  - HR jobs session lock;
  - outbox and mail loops that survive errors;
  - readiness 503;
  - production config guard;
  - `contentDisposition` and `safeFileName` for downloads and uploads.
- Contracts: `safeNextPath` (used by the Web Portal and Console sign-in); contrast enforcement in the theme builder.
- Web and Console:
  - CSP and security headers;
  - self-hosted fonts (`@fontsource`);
  - Next.js standalone output for the images;
  - `/healthz`;
  - accessibility fixes.
- Dependencies: nodemailer 8.0.11, zod 4.6.7, fflate 0.8.3, axe-core 4.14.0 (dev).
- Docs: `docs/ops/runbook.md`, `docs/security-review.md`, the "Phase 12 review" section in `docs/security.md`, and "Running in production" in the README.

## Tests

- `apps/api/test/production.spec.ts` (11 tests):
  - the config guard;
  - audit rows only at commit, and rolled back with the transaction;
  - opposite lock order without deadlock;
  - single attendance recompute waits for bulk;
  - outbox survives a database error;
  - HR jobs run once at a time;
  - the public route allowlist;
  - forged and unsigned tokens refused;
  - non-English download names.
- `apps/api/src/platform/http/content-disposition.spec.ts`, `packages/contracts/src/safe-path.spec.ts`, and contrast assertions in `experience.spec.ts`.
- `e2e/load-workflows.cjs`, `e2e/a11y.cjs` and `e2e/deploy-smoke.cjs`, all run in CI: the e2e job has the accessibility check and the load test, and the new `deploy` job builds and smoke-tests the production stack.
