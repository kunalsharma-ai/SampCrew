#!/bin/bash
# Smoke test of the production stack: builds the images, starts compose.yml with TLS on localhost, then checks it
# from the outside: health, TLS and security headers, sign-in and the main pages in a browser, the Console's IP
# allowlist, a backup, and a restore of that backup into a new database with its checks.
# The API signs in to MongoDB as its own crew_api user, which the migration job creates.
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
root_pw=$(grep '^MONGO_ROOT_PASSWORD=' .env.smoke | cut -d= -f2-)
api_pw=$(grep '^MONGODB_API_PASSWORD=' .env.smoke | cut -d= -f2-)
admin() { echo "mongodb://root:$root_pw@mongo:27017/$1?replicaSet=rs0&authSource=admin"; }
count() { dc exec -T mongo mongosh --quiet "$(admin "$1")" --eval 'db.employees.countDocuments()'; }
dc exec -T -e RESTORE_MONGODB_URL="$(admin crew_restore_check)" -e MONGODB_API_PASSWORD="$api_pw" \
  backup /app/infra/deploy/scripts/restore.sh "$file"
src=$(count crew)
dst=$(count crew_restore_check)
[ "$src" = "$dst" ] || { echo "restore has $dst employees, source has $src" >&2; exit 1; }
echo "restore matches the source ($src employees)"
# A restore never overwrites: a second one into the same database is refused.
if dc exec -T -e RESTORE_MONGODB_URL="$(admin crew_restore_check)" backup /app/infra/deploy/scripts/restore.sh "$file" > /dev/null 2>&1; then
  echo "restore.sh overwrote a database that was not empty" >&2; exit 1
fi
dc exec -T mongo mongosh --quiet "$(admin crew_restore_check)" --eval 'db.dropDatabase()' > /dev/null
echo "production stack smoke test passed"
