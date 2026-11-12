#!/bin/bash
# Smoke test of the production stack: builds the images, starts compose.yml with TLS on localhost, then checks it
# from the outside: health, TLS and security headers, sign-in and the main pages in a browser, the Console's IP
# allowlist, a backup with its off-site copy, a restore of that backup into a new database with its checks, and a
# point-in-time restore of the live database to a chosen second.
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
PBM_OPLOG_SPAN_MIN=1
BACKUP_REMOTE=offsite:/tmp/offsite
OUT
  ./gen-secrets.sh
} > .env.smoke
cp .env.smoke .env  # env_file in compose.yml reads .env
# An rclone "local" remote inside the backup container stands in for object storage.
echo 'RCLONE_CONFIG_OFFSITE_TYPE=local' > offsite.env
trap '[ "${SMOKE_KEEP:-}" = 1 ] || { dc logs --no-color > smoke-logs.txt 2>&1 || true; dc down -v > /dev/null 2>&1 || true; rm -f .env .env.smoke offsite.env; }' EXIT

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

# The backup went off-site (archives, and the point-in-time backups encrypted), and the service reports healthy.
dc exec -T backup sh -c 'rclone lsf /tmp/offsite/archives | grep -q "^crew-db-.*\.enc$" && [ -n "$(rclone lsf /tmp/offsite/pbm)" ] && ! rclone lsf -R /tmp/offsite/pbm | grep -q "rs0/"' \
  || { echo "off-site copy is missing or not encrypted" >&2; exit 1; }
dc exec -T backup /app/infra/deploy/scripts/backup.sh --check
echo "backups copied off-site and encrypted"
# The API's own user can read the point-in-time backup status (for System health), and nothing else of PBM's.
api_q() { dc exec -T mongo mongosh --quiet "mongodb://crew_api:$api_pw@mongo:27017/crew?replicaSet=rs0&authSource=crew" --eval "$1"; }
[ "$(api_q 'db.getSiblingDB("admin").pbmBackups.countDocuments({ status: "done" }) > 0')" = true ] || { echo "crew_api cannot read the backup status" >&2; exit 1; }
[ "$(api_q 'try { db.getSiblingDB("admin").pbmConfig.findOne(); "readable" } catch (e) { e.codeName }')" = Unauthorized ] || { echo "crew_api can read PBM settings" >&2; exit 1; }

# Point-in-time restore: change a record, note the time, then damage the data; restore to that second.
q() { dc exec -T mongo mongosh --quiet "$(admin crew)" --eval "$1"; }
q 'db.tenants.updateOne({ slug: "demo-northwind" }, { $set: { name: "Northwind PITR" } })' > /dev/null
before=$(q 'db.leave_requests.countDocuments()')
sleep 2; target=$(date -u +%Y-%m-%dT%H:%M:%S); sleep 2
q 'db.tenants.updateOne({ slug: "demo-northwind" }, { $set: { name: "Northwind damaged" } }); db.leave_requests.deleteMany({})' > /dev/null
covered() { dc exec -T pbm bash -c "pbm status --out json | jq -e --argjson t $(date -u -d "$target" +%s) '(.backups.pitrChunks.pitrChunks // []) | map(.range.end) | max > \$t'" > /dev/null 2>&1; }
for _ in $(seq 1 60); do covered && break; sleep 5; done
covered || { echo "point-in-time backups never reached $target" >&2; dc exec -T pbm pbm status >&2; exit 1; }
dc stop api backup > /dev/null
dc exec -T pbm /crew/pitr-restore.sh "$target" --yes
name=$(q 'db.tenants.findOne({ slug: "demo-northwind" }).name')
after=$(q 'db.leave_requests.countDocuments()')
[ "$name" = "Northwind PITR" ] && [ "$after" = "$before" ] || { echo "point-in-time restore gave \"$name\" and $after leave requests (want Northwind PITR and $before)" >&2; exit 1; }
dc up -d --wait --wait-timeout 300
dc run --rm -T migrate sh -c 'cd /app/db && ./node_modules/.bin/tsx scripts/restore-check.ts'
echo "point-in-time restore to $target verified ($before leave requests back)"
echo "production stack smoke test passed"
