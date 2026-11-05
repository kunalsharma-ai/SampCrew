#!/bin/bash
# Smoke test of the production stack: builds the images, starts compose.yml with TLS on localhost, then checks it
# from the outside: health, TLS and security headers, sign-in and the main pages in a browser, the Console's IP
# allowlist, a backup, and a restore of that backup into a new database with its checks.
#
#   infra/deploy/smoke.sh            build and test
#   SMOKE_SKIP_BUILD=1 smoke.sh      reuse images already built
#   SMOKE_KEEP=1 smoke.sh            leave the stack running afterwards
set -euo pipefail
cd "$(dirname "$0")"
export COMPOSE_PROJECT_NAME=crew-smoke
dc() { docker compose -f compose.yml -f compose.smoke.yml --env-file .env.smoke "$@"; }

demo_password="Smoke-Demo-$(openssl rand -hex 6)"
{
  sed -e 's/^CREW_ENV=.*/CREW_ENV=staging/' -e 's/^CREW_SEED_DEMO=.*/CREW_SEED_DEMO=true/' env.production.example
  cat <<OUT
CREW_WEB_ADDRESS=https://localhost:8443
CREW_CONSOLE_ADDRESS=https://localhost:8444
CREW_API_ADDRESS=https://localhost:8445
CREW_TLS_DIRECTIVE=tls internal
WEB_PUBLIC_URL=https://localhost:8443
CONSOLE_PUBLIC_URL=https://localhost:8444
API_PUBLIC_URL=https://localhost:8445
CORS_ORIGINS=https://localhost:8443,https://localhost:8444
CREW_DEMO_PASSWORD=$demo_password
CREW_BOOTSTRAP_ADMIN_EMAIL=admin@smoke.crew.test
CREW_BOOTSTRAP_ADMIN_PASSWORD=Smoke-Admin-$(openssl rand -hex 8)
OUT
  ./gen-secrets.sh
} > .env.smoke
cp .env.smoke .env  # env_file in compose.yml reads .env
trap '[ "${SMOKE_KEEP:-}" = 1 ] || { dc logs --no-color > smoke-logs.txt 2>&1 || true; dc down -v > /dev/null 2>&1 || true; rm -f .env .env.smoke; }' EXIT

if [ -z "${SMOKE_SKIP_BUILD:-}" ]; then dc build; fi
dc up -d --wait --wait-timeout 300
echo "stack is up and healthy"

# The migration job ran and finished cleanly.
[ "$(docker inspect -f '{{.State.ExitCode}}' crew-smoke-migrate-1)" = 0 ]

WEB_URL=https://localhost:8443 CONSOLE_URL=https://localhost:8444 API_URL=https://localhost:8445 CREW_DEMO_PASSWORD="$demo_password" \
  node ../../e2e/deploy-smoke.cjs

# Backup now, then restore it into a new, empty database and verify it.
dc exec -T backup /app/infra/deploy/scripts/backup.sh
file=$(dc exec -T backup sh -c 'ls -1t /backups/crew-db-* | head -1')
echo "latest backup: $file"
dc exec -T postgres psql -U postgres -qc 'create database crew_restore_check'
pg_pw=$(grep '^POSTGRES_PASSWORD=' .env.smoke | cut -d= -f2-)
api_pw=$(grep '^DATABASE_API_PASSWORD=' .env.smoke | cut -d= -f2-)
# Same cluster as the live database, so the crew_api password must stay the live one (roles are cluster-wide).
dc exec -T -e RESTORE_DATABASE_URL="postgres://postgres:$pg_pw@postgres:5432/crew_restore_check" -e DATABASE_API_PASSWORD="$api_pw" \
  backup /app/infra/deploy/scripts/restore.sh "$file"
src=$(dc exec -T postgres psql -U postgres -d crew -Atc 'select count(*) from employees')
dst=$(dc exec -T postgres psql -U postgres -d crew_restore_check -Atc 'select count(*) from employees')
[ "$src" = "$dst" ] || { echo "restore has $dst employees, source has $src" >&2; exit 1; }
echo "restore matches the source ($src employees)"
dc exec -T postgres psql -U postgres -qc 'drop database crew_restore_check'
echo "production stack smoke test passed"
