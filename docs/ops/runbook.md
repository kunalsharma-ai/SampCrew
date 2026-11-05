# CREW production runbook

How to run CREW in production on one Linux host with Docker, using `infra/deploy/compose.yml`. The same images run on
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
| `postgres` | `postgres:16-alpine` | internal | Bundled database (replace with a managed PostgreSQL 16 for production) |
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
   `CREW_BOOTSTRAP_ADMIN_PASSWORD` (14+ characters), `SMTP_URL` and `MAIL_FROM`, and `CONSOLE_ALLOWED_IPS` (your office
   or VPN ranges). **Keep a copy of `FIELD_ENCRYPTION_KEY` and `BACKUP_PASSPHRASE` in your password manager**: without
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
   two-step verification (required). Create the first customer workspace from the Console; its owner gets an
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
  when they only add tables, columns or functions (true of migrations 0001 to 0020: none drops, renames or retypes a column or table), the previous images keep working
  against the upgraded database. When a release says a migration changes or removes something, restore the
  pre-upgrade backup instead (section 5).
- **Zero downtime** needs two or more API servers behind a load balancer (Kubernetes or similar). With more than one API
  server, `REDIS_URL` must be set (compose sets it), and the daily HR jobs already run on one server at a time.

## 4. Backups

The `backup` service writes `crew-db-<time>.dump` (pg_dump custom format) and `crew-files-<time>.tar.gz` (uploaded
documents, CVs, receipts) to the `backups` volume every `BACKUP_INTERVAL_HOURS` (24), keeps `BACKUP_KEEP_DAYS` (14),
and encrypts both with `BACKUP_PASSPHRASE` (AES-256-GCM; a changed or truncated file refuses to decrypt).

- **Copy them off the host** every day (object storage with versioning and a retention lock is best):
  `docker run --rm -v crew_backups:/b alpine ls /b` shows them; sync that volume with your tool of choice.
- **Backup now**: `docker compose run --rm backup /app/infra/deploy/scripts/backup.sh`
- **With a managed database**, turn on its point-in-time recovery too; the dumps are the portable second copy.
- **Restore drill**: `docker compose run --rm migrate sh -c 'cd /app/db && ./node_modules/.bin/tsx scripts/dr-drill.ts'`
  restores the live database into a scratch copy and checks tables, rows, Row-Level Security and every audit chain.
  Run it monthly and after upgrades; the CI smoke test does a full backup and restore on every change.

## 5. Restore

Restore into a **new, empty** database (the script refuses to overwrite one), check it, then point the API at it:

```sh
docker compose exec postgres psql -U postgres -c 'create database crew_restored'
docker compose run --rm -e RESTORE_DATABASE_URL=postgres://postgres:$POSTGRES_PASSWORD@postgres:5432/crew_restored \
  backup /app/infra/deploy/scripts/restore.sh /backups/crew-db-<time>.dump.enc
```

It recreates the database roles if the server is new, restores, applies any newer migrations, sets the API login's
password from `DATABASE_API_PASSWORD`, and verifies Row-Level Security and every workspace's audit chain. Then set
`POSTGRES_DB=crew_restored` in `.env` and `docker compose up -d --wait`. Restore the files with
`tar -xzf crew-files-<time>.tar.gz -C <files volume>` (decrypt first with
`node /app/infra/deploy/scripts/crypt.mjs decrypt <in> <out>`).

Recovery point: the last backup (24 hours by default; point-in-time recovery on a managed database brings it to
minutes). Recovery time measured by the drill: seconds for the demo data size, growing with the database.

## 6. Secrets

| Secret | Rotate how |
|---|---|
| `JWT_ACCESS_SECRET`, `JWT_PLATFORM_SECRET` | Change and restart the API. Tokens signed with the old secret stop working within the access-token lifetime (15 minutes); to sign everyone out at once, also run `update sessions set revoked_at = now(), revoked_reason = 'rotation' where revoked_at is null;` in psql. |
| `DATABASE_API_PASSWORD` | Change in `.env`, run `docker compose up -d --wait` (the migrate job sets the role's password before the API starts). |
| `POSTGRES_PASSWORD` | `alter role postgres password '...'` in psql, then update `.env`. |
| `REDIS_PASSWORD` | Change and `docker compose up -d --wait`; counters reset, which is harmless. |
| `FIELD_ENCRYPTION_KEY` | **Do not change in place**: MFA secrets and other encrypted fields would become unreadable. Key rotation needs a re-encryption job (not built yet). |
| `BACKUP_PASSPHRASE` | Change for new backups; keep the old one for as long as older backups are kept. |
| `ANTHROPIC_API_KEY`, `SMTP_URL`, `EXPO_ACCESS_TOKEN` | Change and restart the API. |

Never put secrets in the repository, an image, or a ticket. On a platform with a secret manager, inject them as
environment variables from it instead of using `.env`.

## 7. Operating

- **Logs**: the API logs JSON in production (`docker compose logs -f api`); every error has a request id that is also
  shown to the person. Caddy logs requests as JSON. Ship both to your log platform.
- **Monitoring**: alert on `/api/v1/health/ready` from outside, on container restarts, on disk use of the database and
  backups volumes, and on the Console's System health page (database, migrations, outbox backlog, audit chain).
- **Scaling**: raise `DATABASE_POOL_MAX` with care (connections per API server × servers must stay under the
  database's limit). Measured capacity on one 4-core machine is in `docs/ops/load-latest.md` and
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
