# SampCrew production runbook

How to run SampCrew in production on one Linux host with Docker, using `infra/deploy/compose.yml`. The same images run on
any container platform (Kubernetes, ECS, Cloud Run); the compose file is the reference for which settings each service
needs and how the services depend on each other.

What going live still needs from you, and nothing else: **a host, three DNS names, an SMTP account** and, when you want
them, **real keys** for the Claude API and Expo push. Everything below is already built and tested
(`infra/deploy/smoke.sh`, CI job `deploy`).

## 1. What runs

| Service | Image target | Port | Purpose |
|---|---|---|---|
| `proxy` | `caddy:2-alpine` | 80, 443 | TLS (automatic certificates), HSTS, Console IP allowlist, request size limits |
| `web` | `web` | 3000 (internal) | Web Portal (Next.js standalone server) |
| `console` | `console` | 3001 (internal) | SAMPLEDGE Super Admin Console |
| `api` | `api` | 4000 (internal) | NestJS API, background loops (outbox, email, webhooks, workflows, daily HR jobs) |
| `migrate` | `tools` | none | One-shot job before every API start: migrations, catalogue sync, first Super Admin |
| `backup` | `tools` | none | Database and uploaded-file backups every `BACKUP_INTERVAL_HOURS` |
| `mongo` | `mongo:8.0` | internal | Bundled database: a one-node replica set with authentication (or use MongoDB Atlas, see docs/ops/mongodb.md) |
| `redis` | `redis:7-alpine` | internal | Rate-limit counters shared by API servers (nothing persistent) |

The database and Redis sit on an internal network the proxy cannot reach. All images run as non-root users and read
their configuration from the environment; no secret is baked into an image.

Health checks:

| Check | Meaning |
|---|---|
| `GET /api/v1/health/live` | API process is running |
| `GET /api/v1/health/ready` | API can reach the database (used by the image's health check and the load balancer) |
| `GET /healthz` (web, console) | Next.js server is running |
| `GET /healthz?ready=1` (web) | Web Portal can reach the API, so sign-in works |

## 2. First start

1. **Host**: Linux with Docker Engine 24+ and the compose plugin, 4 vCPU and 8 GB RAM for a few thousand employees;
   ports 80 and 443 open to the internet.
2. **DNS**: point three names at the host, for example `crew.example.com`, `api.crew.example.com`,
   `console.crew.example.com`.
3. **Settings**:
   ```sh
   cd infra/deploy
   cp env.production.example .env
   ./gen-secrets.sh >> .env      # fresh database, Redis, token, encryption and backup secrets
   chmod 600 .env
   ```
   Then edit `.env`: the three addresses and URLs, `ACME_EMAIL`, `CREW_BOOTSTRAP_ADMIN_EMAIL` and a strong
   `CREW_BOOTSTRAP_ADMIN_PASSWORD` (14+ characters), and `CONSOLE_ALLOWED_IPS` (your office
   or VPN ranges). Email, Claude AI, mobile push, virus scanning and mobile sign-in addresses do not need `.env`:
   set them up after the first sign-in in Console > Integrations (section 7). **Keep a copy of `FIELD_ENCRYPTION_KEY` and `BACKUP_PASSPHRASE` in your password manager**: without
   them, encrypted fields and backups cannot be read.
4. **Start**:
   ```sh
   docker compose up -d --build --wait
   docker compose ps                 # every service healthy, migrate "exited (0)"
   docker compose logs migrate       # "Applied N migration(s)", "Bootstrapped platform super admin ..."
   ```
   The API refuses to start in `production` with plain-http addresses, localhost origins, wildcard CORS, http mobile
   return addresses or template secrets, and lists every problem at once. The seed refuses demo data in production.
5. **First sign-in**: open the Console from an allowed network, sign in as the bootstrap Super Admin and enrol
   two-step verification (required), change the bootstrap password, and add a second Super admin. Console admins,
   their roles and the recovery command for a lost phone or lockout: [console-admins.md](console-admins.md). Create the first customer workspace from the Console; its owner gets an
   invitation email.
6. **Check from outside** (any machine):
   ```sh
   WEB_URL=https://crew.example.com CONSOLE_URL=https://console.crew.example.com API_URL=https://api.crew.example.com \
   CREW_DEMO_PASSWORD=unused SMOKE_STRICT_TLS=1 node e2e/deploy-smoke.cjs
   ```
   (Without demo data the browser sign-in step fails; the health, TLS and header checks before it still run.)

## 3. Upgrades and rollback

Build images in CI, tag them with the git commit, and push them to your registry:

```sh
for t in api web console tools; do
  docker build -f infra/docker/Dockerfile --target $t -t registry.example.com/crew-$t:$GIT_SHA .
  docker push registry.example.com/crew-$t:$GIT_SHA
done
```

On the host set `CREW_IMAGE_PREFIX=registry.example.com/crew` and `CREW_VERSION=<sha>` in `.env`, then:

```sh
docker compose run --rm backup /app/infra/deploy/scripts/backup.sh   # backup right before the upgrade
docker compose pull && docker compose up -d --wait                    # migrate runs first, then the API
```

- **Rollback**: set `CREW_VERSION` back and run `docker compose up -d --wait`. Check the release's migrations first:
  when they only add collections, fields or indexes, the previous images keep working against the upgraded
  database. A migration that tightens a validator or renames a field is called out in its release notes. When a release says a migration changes or removes something, restore the
  pre-upgrade backup instead (section 5).
- **Zero downtime** needs two or more API servers behind a load balancer (Kubernetes or similar). With more than one API
  server, `REDIS_URL` must be set (compose sets it), and the daily HR jobs already run on one server at a time.

## 4. Backups

The `backup` service writes `crew-db-<time>.archive.gz` (a gzip `mongodump` archive) and `crew-files-<time>.tar.gz` (uploaded
documents, CVs, receipts) to the `backups` volume every `BACKUP_INTERVAL_HOURS` (24), keeps `BACKUP_KEEP_DAYS` (14),
and encrypts both with `BACKUP_PASSPHRASE` (AES-256-GCM; a changed or truncated file refuses to decrypt).

- **Copy them off the host** every day (object storage with versioning and a retention lock is best):
  `docker run --rm -v crew_backups:/b alpine ls /b` shows them; sync that volume with your tool of choice.
- **Backup now**: `docker compose run --rm backup /app/infra/deploy/scripts/backup.sh`
- **On MongoDB Atlas**, turn on continuous cloud backup (point-in-time recovery) too; the archives are the portable
  second copy. Each collection in an archive is consistent, but writes made during the dump can be in some
  collections and not others, so the archives are a daily safety copy, not point-in-time recovery.
- **Restore drill**: `docker compose run --rm migrate sh -c 'cd /app/db && ./node_modules/.bin/tsx scripts/dr-drill.ts'`
  restores the live database into a scratch copy and checks collections, documents, validators, indexes and every
  audit chain.
  Run it monthly and after upgrades; the CI smoke test does a full backup and restore on every change.

## 5. Restore

Restore into a **new, empty** database (the script refuses to overwrite one), check it, then point the API at it:

```sh
docker compose run --rm \
  -e RESTORE_MONGODB_URL="mongodb://root:$MONGO_ROOT_PASSWORD@mongo:27017/crew_restored?replicaSet=rs0&authSource=admin" \
  -e MONGODB_API_PASSWORD="$MONGODB_API_PASSWORD" \
  backup /app/infra/deploy/scripts/restore.sh /backups/crew-db-<time>.archive.gz.enc
```

It restores the archive under the new database's name, applies any newer migrations, creates the API's `crew_api`
user in it, and checks that every collection has its validator and every audit chain (each workspace's and the
platform's) verifies. Then point the API at it: set `MONGODB_URL` and `MONGODB_ADMIN_URL` in `.env` to the
`crew_restored` database (`authSource=crew_restored` for `crew_api`) and `docker compose up -d --wait`. Restore the files with
`tar -xzf crew-files-<time>.tar.gz -C <files volume>` (decrypt first with
`node /app/infra/deploy/scripts/crypt.mjs decrypt <in> <out>`).

Recovery point: the last backup (24 hours by default; point-in-time recovery on a managed database brings it to
minutes). Recovery time measured by the drill: seconds for the demo data size, growing with the database.

## 6. Secrets

| Secret | Rotate how |
|---|---|
| `JWT_ACCESS_SECRET`, `JWT_PLATFORM_SECRET` | Change and restart the API. Tokens signed with the old secret stop working within the access-token lifetime (15 minutes); to sign everyone out at once, also run `db.sessions.updateMany({ revoked_at: null }, { $set: { revoked_at: new Date(), revoked_reason: 'rotation' } })` in mongosh. |
| `MONGODB_API_PASSWORD` | Change in `.env`, run `docker compose up -d --wait` (the migrate job sets the `crew_api` user's password before the API starts). |
| `MONGO_ROOT_PASSWORD` | `db.getSiblingDB('admin').changeUserPassword('root', '...')` in mongosh, then update `.env`. (`MONGO_INITDB_ROOT_PASSWORD` only applies on the first start.) |
| `MONGO_REPLICA_KEY` | Only matters when you add members to the replica set; change it on every member at once and restart them. |
| `REDIS_PASSWORD` | Change and `docker compose up -d --wait`; counters reset, which is harmless. |
| `FIELD_ENCRYPTION_KEY` | In three steps, below. Never just replace it: values written with the old key (MFA secrets, bank and tax identifiers, webhook, Slack and single sign-on secrets, and the keys and passwords saved in Console > Integrations) need it to be read. |
| `BACKUP_PASSPHRASE` | Change for new backups; keep the old one for as long as older backups are kept. |
| Claude API key, SMTP password, Expo access token | Paste the new value in Console > Integrations, press Test connection, then Save. No restart; every API server uses it within 5 seconds. (If they still come from `ANTHROPIC_API_KEY`, `SMTP_URL`, `EXPO_ACCESS_TOKEN` in `.env`, change them there and restart, or move them to the Console.) |

**Rotating `FIELD_ENCRYPTION_KEY`** (on a schedule, or at once if the key may have leaked):

1. Back up (section 4). Generate a key with `openssl rand -base64 32`. In `.env`, move the current value to
   `FIELD_ENCRYPTION_KEYS_PREVIOUS` and put the new one in `FIELD_ENCRYPTION_KEY`, then `docker compose up -d --wait`.
   The API now writes with the new key and still reads both, so nobody is signed out and nothing stops working.
2. Re-encrypt everything with the new key: `docker compose exec api node dist/cli/rotate-field-key.js`. It works in
   small batches while SampCrew is in use, can be run again safely, and writes `platform.field_key_rotated` to the
   platform audit log. `node dist/cli/rotate-field-key.js --check` only counts what is left (exit code 2 while any).
   The Console's System health page shows the current key id and how many values are still on an older key.
3. When nothing is left, empty `FIELD_ENCRYPTION_KEYS_PREVIOUS` and `docker compose up -d --wait`. Keep the old key
   with your backups for as long as backups made before the rotation are kept: they still need it.

Download links are signed with `FILE_URL_SECRET` (or, if that is empty, a key derived from `FIELD_ENCRYPTION_KEY`),
so links handed out in the last five minutes stop working after a rotation; people just open the file again.

After upgrading from a release before key ids (Phase 13), System health counts every existing value as "on an older
key": run step 2 once with no previous key set, and every value is rewritten in the new format.

Never put secrets in the repository, an image, or a ticket. On a platform with a secret manager, inject them as
environment variables from it instead of using `.env`.

## 7. Operating

- **Integrations (Console > Integrations)**: Claude AI, email (SMTP), mobile push (Expo), virus scanning (ClamAV) and
  the mobile app's single sign-on addresses are set up by a Super admin in the Super Admin Console, with numbered
  steps, a Test connection button that tries the values against the real service before saving, and an on/off switch.
  Keys and passwords are encrypted with `FIELD_ENCRYPTION_KEY` and only their last four characters are ever shown.
  A value saved in the Console wins over `.env`; while nothing is saved for an integration, its `.env` variables are
  used (so an existing install keeps working), and the page says which ones still come from the server's settings
  file. "Use server settings instead" removes the Console value. Every save, test and removal is in the Platform
  audit. Workspace integrations (Slack, webhooks, API keys, single sign-on) stay in each workspace's own Settings.
  What must stay in `.env`: database, Redis, token secrets, `FIELD_ENCRYPTION_KEY` (it protects the saved secrets,
  so it cannot be stored next to them), public URLs and CORS origins, because the API needs them before it can read
  the database.
- **Virus scanning of uploads**: start ClamAV with `docker compose --profile scan up -d`, then in Console >
  Integrations > Virus scanning enter `tcp://clamav:3310`, test it and switch it on (or set
  `CLAMAV_URL=tcp://clamav:3310` in `.env` and `docker compose up -d --wait`). Every uploaded document, expense
  receipt and CV, including CVs from the public careers page, is scanned before it is stored; a flagged file is
  refused with a message and never written, and the log line names the signature and workspace. While scanning is
  on and ClamAV is down, uploads are refused rather than stored unscanned, and System health shows the scanner as
  unreachable. ClamAV needs about 1.5 GB of memory and outbound access to `database.clamav.net` for signature
  updates. Files uploaded before scanning was switched on are not scanned retroactively.

- **Logs**: the API logs JSON in production (`docker compose logs -f api`); every error has a request id that is also
  shown to the person. Caddy logs requests as JSON. Ship both to your log platform.
- **Monitoring**: alert on `/api/v1/health/ready` from outside, on container restarts, on disk use of the database and
  backups volumes, and on the Console's System health page (database, migrations, outbox backlog, audit chain).
- **Scaling**: raise `MONGODB_POOL_MAX` with care (connections per API server × servers must stay under the
  database's limit; on Atlas it depends on the cluster tier). For high availability run a three-member replica set
  or Atlas; one node has no failover. Measured capacity on one 4-core machine is in `docs/ops/load-latest.md` and
  `docs/ops/load-workflows-latest.md`; measure again on the production hardware.
- **Attendance devices** that use the ZKTeco push protocol call `https://<API address>/iclock/...`. Devices that can
  only speak plain http need a separate http listener for `/iclock` only; it is not enabled by default.
- **Mobile app**: build it with `EXPO_PUBLIC_CREW_API_URL=https://<API address>`; its single sign-on return address
  `crew://sso` must stay in `MOBILE_SSO_REDIRECTS`.

## 8. Incidents

1. Check `docker compose ps` and `docker compose logs --since 30m api`.
2. Database unreachable: the API keeps running and answers `503` on `/health/ready`; background loops log and retry
   each tick. Fix the database, nothing else to restart.
3. A bad release: roll back the images (section 3).
4. Data damaged or deleted by mistake: restore the latest good backup into a new database (section 5) and copy the
   affected rows across, or switch to it entirely.
5. Suspected breach: rotate the JWT secrets (signs everyone out), the database and Redis passwords; review the
   audit trail (Console and each workspace's Audit log, hash-chained); see `docs/security.md`.
