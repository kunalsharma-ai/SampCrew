# Phase 23 report: every key in the database

Kunal asked (16 November 2026) that every API key be entered and stored in SampCrew's database, not in `.env` or any
other settings file, so that anyone can set SampCrew up without editing server files. He then set two rules:

- only the database keys stay in `.env`;
- the master encryption key goes in the database too.

After this phase, `.env` holds the database and Redis connections, the backup passphrase, and public addresses and
limits. Nothing else in it is secret.

## Working end to end

- **Console > Integrations holds every outside service.** These are Claude AI, email (SMTP), mobile push (Expo), virus
  scanning (ClamAV), the mobile app's single sign-on addresses, Razorpay, Stripe and the new **Off-site backups**.
  - Off-site backups can use Amazon S3 or S3-compatible storage, Azure Blob, SFTP or a mounted folder.
  - Each service has numbered steps, a **Test connection** button that tries the values against the real service, an
    on/off switch and **Remove setting**.
  - Secrets are encrypted (AES-256-GCM). Only their last four characters are ever shown.
  - Each save, test, removal and import is recorded in the Platform audit.
  - The environment fallback the API used to have is gone. A value is either saved in the database or the service is
    off. The one exception is the mobile sign-in address `crew://sso`, which is built in.
- **Off-site backup settings come from the database.**
  - Before every copy, `backup.sh` runs `packages/db/scripts/backup-settings.ts`. It reads the saved settings,
    decrypts them and hands rclone its `RCLONE_CONFIG_OFFSITE_*` settings, so a change applies without a restart.
  - If the database can't be read, the script exits with code 3 and `backup.sh` keeps whatever it was started with.
    That is the disaster-recovery path, when the database itself is being restored.
  - Test connection is a real check:
    - S3 requests are signed with AWS Signature Version 4, checked against AWS's published examples.
    - Azure uses SharedKey signing.
    - SFTP gets an SSH banner check.
    - For S3 and Azure, a small check file is written, listed and deleted.
- **The encryption key and the sign-in signing keys live in the database.**
  - The first API start creates a random field encryption key (`field_keys`). It also creates the two token signing
    keys (`instance_secrets`), encrypted with that key. Every later start, and every other server, reads the same ones.
  - Rotating the encryption key is now a command, not an edit to `.env`:
    - `rotate-field-key --new` adds a key;
    - restart the API;
    - `rotate-field-key` re-encrypts every value;
    - `rotate-field-key --retire` drops the old key, and is refused while any value still needs it.
  - Each step is audited.
  - Download links are signed with a key derived from the signing key, so a rotation does not break them.
- **First-run setup without a password in a file.** On a new installation, the API log prints a one-time setup code.
  Console > `/setup` uses that code to create the first Super admin. The code is 75 bits, allows 5 tries a minute, is
  deleted once used, and the step is audited. The old `CREW_BOOTSTRAP_ADMIN_*` variables still work for unattended
  installs.
- **Moving an existing install over.** On the first start, the old variables are moved into the database:
  - `SMTP_URL`/`MAIL_FROM`, `ANTHROPIC_API_KEY` and the other `AI_*`, `EXPO_*`, `CLAMAV_URL` and
    `MOBILE_SSO_REDIRECTS`;
  - `JWT_ACCESS_SECRET`/`JWT_PLATFORM_SECRET`;
  - `FIELD_ENCRYPTION_KEY`/`FIELD_ENCRYPTION_KEYS_PREVIOUS`;
  - `BACKUP_REMOTE`, `offsite.env` and `BACKUP_ALERT_WEBHOOK`.

  Each value is checked with the same rules as the Console form, written once (`platform.integration_imported`) and
  never read again. The API log and the Console list the lines to delete. If the database already holds encrypted
  values but has no key and `FIELD_ENCRYPTION_KEY` is gone, the API refuses to start rather than create a key that
  can't open them.
- **Scripted setups** use `node dist/cli/integrations.js list | set <key> <json|-> | test <key> | remove <key>`. It
  writes the same records with the same checks, takes the JSON on standard input to keep keys out of shell history,
  and is audited as "integrations command (user@host)". CI and `infra/deploy/smoke.sh` set integrations this way, and
  the smoke test fails if a key is left in `.env`.

## Trade-off (Kunal's choice)

Because the master encryption key is in the database, anyone with a copy of the database, or a backup together with
`BACKUP_PASSPHRASE`, can open every saved key. That is the price of needing nothing but the database connection.

How SampCrew limits the risk:

- MongoDB is not published to the internet in `infra/deploy/compose.yml`.
- Backups are encrypted with `BACKUP_PASSPHRASE`, which stays in `.env` and should be kept apart from the backups.

`BACKUP_PASSPHRASE` itself can't be moved into the database: it is what opens a backup when the database is gone.

## Tests

- `apps/api/test/keys-in-database.spec.ts` checks:
  - S3/Azure signing, the SFTP check and the rclone setting mapping;
  - shell quoting and the old-variable parsers;
  - first-run setup on a fresh database;
  - signing keys created, persisted, ignored when set in env, and imported from env;
  - the encryption key: created at random, imported from `FIELD_ENCRYPTION_KEY`, refused when encrypted data has no
    key, and rotated with add, re-encrypt and retire.
- `platform-integrations.spec.ts` uses a local S3 stub that verifies Signature Version 4.
- `gaps.spec.ts` runs the rotation tests against the database key ring.
- A run against a real `rclone serve s3` covered:
  - a fresh database and the first start creating the key;
  - an old `offsite.env` moved in;
  - settings read back and an rclone copy made;
  - the CLI test;
  - a full key rotation, with the backup settings still opening afterwards;
  - the audit trail;
  - exit code 3 for an unreachable database.

## Not yet

- Uploaded files still go to local disk. S3 storage for uploads is not built, so it has no keys to manage.
- Running API servers pick up a new encryption key only when restarted, which is step 2 of the rotation.
- The Console has no screen for rotating the encryption key; it is a command, shown on System health.

## Fixed on the way (CI on main had been red since 13 November)

- Web Portal sign-in: when a workspace requires single sign-on, a refused password sign-in now carries the email over
  to the single sign-on step (`e2e:enterprise`). The form read the email from a stale render.
- Console alerts: the body text of warning alerts is at full strength so it meets WCAG AA contrast (`e2e:a11y`, Console
  System health). The same change was on PR #39, which was never merged.
