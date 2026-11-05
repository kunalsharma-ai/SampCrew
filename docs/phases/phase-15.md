# Phase 15 report: setting up every integration from the CRM, not the server

Kunal asked for every integration to be set up through the CRM rather than on the server. Before this phase,
workspace integrations (Slack, webhooks, API keys, single sign-on) were already in each workspace's
Settings > Integrations, but the installation-wide ones could only be changed by editing the API server's `.env` file
and restarting it: the Claude API key and model, SMTP email, Expo push, ClamAV virus scanning and the mobile app's
single sign-on addresses.

Those five now live in a new **Super Admin Console > Integrations** page. Each one has numbered setup steps with links
to the provider, a form, a **Test connection** button that tries the values on screen against the real service
before anything is saved, an on/off switch, and **Save**. Saved settings take effect on every API server within five
seconds, with no restart.

## How it works

- **Storage**: one row per integration in `platform_integrations` (migration 0022), readable only by the platform
  database role. Non-secret values are JSON; secrets (Claude API key, SMTP password, Expo access token) are one
  AES-256-GCM payload encrypted with `FIELD_ENCRYPTION_KEY`, included in the key-rotation CLI. The browser only ever
  receives the last four characters of a secret.
- **Precedence**: a value saved in the Console wins. While nothing is saved for an integration, its `.env` variables
  are used, so existing installs keep working and a new install can still be bootstrapped from `.env`. The Console
  shows each integration as "Set in Console", "From server settings" or "Not set up", and "Use server settings
  instead" removes the Console value.
- **Secrets**: leaving a secret field empty keeps the saved one, so moving from `.env` to the Console needs no
  re-typing. A saved key or password is only reused for the same server address: if the Claude API address or the
  SMTP host, port or user changes, the secret must be typed again, so a changed address cannot be used to send the
  saved secret elsewhere.
- **Tests**: Claude AI sends one tiny message ("Reply with OK", 16 tokens max); Email signs in to the SMTP server and,
  given an address, sends a real test email; Mobile push checks that Expo accepts CREW's requests (and can alert one
  device from its push token); Virus scanning sends clamd a PING. A test result is shown with the integration only
  when it was run on exactly the saved values, and becomes "Changed since last test" after an edit.
- **Who**: everyone with System health access can view the page; only Super admins (new capability
  `integrations:manage`) can save, test or remove. Every save, test and removal is in the Platform audit, with no
  secret in it.
- **Workspaces** see a read-only "Provided by SAMPLEDGE" section in Settings > Integrations showing which of these
  services are on (never their settings), plus a shortcut to Single sign-on (Okta, Entra ID, Google, SAML).
- **Production rules**: in staging and production the Console refuses a plain-http Claude API address, SMTP without
  STARTTLS or TLS, and http mobile sign-in addresses.

## Still in `.env`, and why

Database and Redis connections, token secrets, `FIELD_ENCRYPTION_KEY`, public URLs and CORS origins. The API needs
them before it can reach the database, and the encryption key protects the secrets stored in the database, so it
cannot be kept next to them. Test-only switches (`INTEGRATIONS_ALLOW_PRIVATE_URLS`, `SLACK_WEBHOOK_BASE_URL`,
`EXPO_PUSH_URL`) also stay in `.env` on purpose.

## Working end to end, and not yet

### Working end to end

- Console > Integrations lists Claude AI, Email (SMTP), Mobile push (Expo), Virus scanning (ClamAV) and Mobile app
  single sign-on, with where each value comes from, the last saved time and who saved it.
- Claude AI: a wrong key fails the test with "the API key was refused"; the right key passes; once saved and switched
  on, every workspace's AI features use it (the AI gateway rebuilds its client when the settings change). Switching it
  off stops all AI calls.
- Email: the test signs in and delivers a real email; once saved, queued email (invitations, approvals, payslips,
  proposals) goes out through those settings, and switching it off marks new email as not delivered.
- Mobile push: the push sender uses the saved switch and access token; a wrong token fails the test with Expo's 401.
- Virus scanning: uploads are scanned with the saved address; System health reads it; an unreachable scanner fails
  the test.
- Mobile app single sign-on: only the saved app addresses can receive a finished sign-in; switching it off refuses all.
- `.env` values still work while nothing is saved (checked by the existing AI browser flow, which configures AI only
  through `.env`).
- Tests: `apps/api/test/platform-integrations.spec.ts` (17 tests) against a local Claude API stand-in, a real SMTP
  server with a password, an Expo push stand-in and a clamd stand-in. Browser flow `pnpm e2e:platform-integrations`
  (own CI step): the console admin tests a wrong and right Claude key, saves AI, sends a real SMTP test email, saves
  email, fails an unreachable scanner, and the workspace owner then sees the services as on and an invitation is
  delivered through the Console's SMTP settings. The Console smoke and accessibility checks now include the page.

### Not yet

- No real provider was called: the Claude API, SMTP, Expo and ClamAV tests ran against local stand-ins (no real key
  is available here). The first real check is pasting a real Claude key and SMTP details in Console > Integrations
  and pressing Test connection.
- Object storage (S3 or R2) is still not built, so file storage has nothing to set up yet; files stay on the API
  server's disk. Backups stay a server job (infra/deploy).
- Microsoft Teams, Google Workspace, Microsoft 365, WhatsApp, SMS, accounting and job boards are still listed as
  planned connectors in the workspace's Settings > Integrations.
- Several API servers pick up a change within five seconds rather than at once (each keeps a five-second cache).
