# Phase 13 report: the last gaps that needed nothing from outside

Phase 13 closes the open items from the Phase 12 security review that could be done without real accounts, keys or
a host:

- **Rotating the field encryption key.**
- **Virus scanning of uploads.**
- **A Content Security Policy without inline scripts.**
- **An accessibility check of the signed-in Super Admin Console.**

It ends with the full list of what is left, all of which needs Kunal.

## Working end to end, and not yet

### Working end to end

API tests are in `apps/api/test/gaps.spec.ts` (7 tests), and the policy rules in `packages/contracts/src/csp.spec.ts`.

- **Field encryption key rotation** (runbook, "Secrets"):
  - Encrypted values (MFA secrets, bank and tax identifiers, webhook, Slack and single sign-on secrets) now name the key that wrote them.
  - The API reads with a key ring: `FIELD_ENCRYPTION_KEY` plus any old keys in `FIELD_ENCRYPTION_KEYS_PREVIOUS`.
  - `node dist/cli/rotate-field-key.js` rewrites everything with the current key while CREW is in use: in small batches, safe to run again, and recorded in the platform audit log. `--check` only counts what is left.
  - The Console's System health page shows the current key id and how many values are still on an older key.
  - **Verified:** an owner whose MFA secret was written with the old key, in the format before key ids, signed in with two-step verification during the rotation. After the job ran, every value opened with the new key alone, and a second run changed nothing.
  - **Verified:** a value no key can open stops the job, with its table and row named.
  - **Verified:** a test fails if a new encrypted column is ever left out of the job.
- **Virus scanning of uploads** (runbook, "Operating"):
  - With `CLAMAV_URL` set, every uploaded document, expense receipt and CV, including CVs from the public careers page, is sent to ClamAV before it is stored. The API uses clamd's own INSTREAM protocol.
  - A flagged file is refused with a clear message and never written.
  - While the scanner is down, uploads are refused instead of stored unscanned, and System health shows it as unreachable.
  - ClamAV is in `infra/deploy/compose.yml` as the optional profile `scan`.
  - **Verified** with the standard EICAR test file:
    - against a **TEST STUB** of clamd in the normal test run;
    - against **real ClamAV** with current signatures in the new CI job `malware-scan`. This sandbox cannot download ClamAV's signatures, so the real check runs only in CI.
- **Content Security Policy without inline scripts**:
  - The Web Portal and Console middleware send a new random nonce with every page, and the policy runs only scripts that carry it (`'nonce-…' 'strict-dynamic'`). Next.js adds the nonce to its own scripts, and the Console's theme script carries it too.
  - Inline scripts, event-handler attributes and scripts from any other site are blocked.
  - Styles still allow inline CSS, which cannot run code.
  - **Verified** with production builds: all 14 browser flows of the main CI step passed with the new policy. The deployment smoke test fails on any policy violation.
- **Accessibility of the signed-in Console** (`pnpm e2e:a11y`, CI step "Accessibility check"):
  - The check now also signs in as the Super Admin, goes through two-step enrolment, and checks the overview, workspaces, a workspace, plans, System health, the audit log and admins, in both themes.
  - 33 screens (66 page views): **0 violations**.
- **System health** now reports from the real configuration: Redis, scanning and key rotation are listed as "not configured" only when they are not.
- **Dependency upgrades held back by the two-week rule** (multer 2.5.0, decode-uri-component 0.5.1) are scheduled for 6 November 2026, when both are old enough.

### Not yet working, or not yet verified

- **ClamAV has not run in this sandbox**, because its signature servers are blocked here. It is verified in CI only.
- **Files uploaded before scanning was switched on are not scanned** retroactively.
- **The policy still allows inline styles** (`style-src 'unsafe-inline'`).
- **multer and decode-uri-component** are not upgraded yet (scheduled for 6 November, as above).

## What only Kunal can do

Everything else CREW needs is built and tested. These need your accounts, devices or decisions:

1. **Review and merge PRs #1 to #14**, in order. Each is stacked on the one before it, and none is merged.
2. **A server and three domain names** (portal, API and Console). Point DNS at the server and follow `docs/ops/runbook.md`. Certificates are automatic once DNS resolves.
3. **An SMTP account** for invitations, password resets and notifications (`SMTP_URL`, `MAIL_FROM`).
4. **Production secrets**: run `infra/deploy/gen-secrets.sh` on the server, and keep `FIELD_ENCRYPTION_KEY` and `BACKUP_PASSPHRASE` in a password manager.
5. **A Claude API key** (`ANTHROPIC_API_KEY`, `AI_PROVIDER=anthropic`), then try the AI features with real data. Only a local stub has answered so far.
6. **Identity providers**: connect a test app in Okta or Microsoft Entra ID for OpenID Connect and SAML, and push users and a group with SCIM. Only local stubs have been used.
7. **Slack**: connect a real test channel and send a test message. Only a stub has received messages.
8. **Mobile**: an Expo account and the Apple and Google developer accounts, to build the iOS and Android apps, test on real phones and switch on push notifications (`EAS_PROJECT_ID`, `EXPO_PUSH_ENABLED`, `EXPO_ACCESS_TOKEN`). The app has only been tested through its browser build.
9. **Off-site backup storage** (object storage with versioning), and a managed PostgreSQL with point-in-time recovery if you want one.
10. **An external penetration test** by an independent firm, against the deployed system.
11. **Decisions for the business**: data residency regions, more country payroll packages, connectors that need partner accounts (Teams, Google, Microsoft 365, WhatsApp, SMS, accounting systems, job boards), and legal review of retention periods and privacy deadlines.

## What was delivered

- API:
  - `platform/auth/crypto.ts` (key ring, key ids);
  - `platform/auth/field-key-rotation.ts` and `cli/rotate-field-key.ts`;
  - `platform/storage/malware-scan.ts`, with scanning in `StorageService.put` for uploads;
  - `CLAMAV_URL` and `FIELD_ENCRYPTION_KEYS_PREVIOUS` in the config;
  - System health additions.
- Contracts: `contentSecurityPolicy` and `cspNonce`.
- Web and Console: the policy set per request in `middleware.ts`; the nonce on the Console's theme script.
- Console: System health shows the encryption key and scanning status.
- Deployment: the `clamav` service (profile `scan`), and the new settings in `env.production.example`.
- CI: a `malware-scan` job against real ClamAV; the accessibility step now covers the signed-in Console.
- Docs: the runbook (key rotation, scanning), the security review's open items, and this report.
