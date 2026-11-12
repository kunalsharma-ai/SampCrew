#!/bin/bash
# Point-in-time recovery for the bundled MongoDB: entrypoint and health check of the "pbm" service in compose.yml,
# which runs Percona Backup for MongoDB (PBM, https://docs.percona.com/percona-backup-mongodb/) next to the database.
#
#   pbm-start.sh            starts pbm-agent, stores the PBM settings, takes a base backup when the last one is older
#                           than PBM_BASE_BACKUP_HOURS (default 24) and deletes backups older than PBM_KEEP_DAYS
#                           (default 14). PBM saves the oplog (every change) in slices of PBM_OPLOG_SPAN_MIN minutes
#                           (default 10) between base backups, so the database can be put back to any second in that
#                           window, not only to the last daily archive.
#   pbm-start.sh --health   succeeds while the agent is up, the last base backup is recent and finished, and the
#                           oplog slices are current
#
# Backups go to /pbm (the "pbm" volume); the backup service copies that folder off the host with the archives when
# BACKUP_REMOTE is set. Restore with scripts/pitr-restore.sh (docs/ops/mongodb.md, "Point-in-time restore").
# Needs PBM_MONGODB_URI: the crew_pbm user that the migration job creates from MONGODB_PBM_PASSWORD.
set -euo pipefail
# The service starts as root only to hand the backup volume to PBM's own user, then runs as that user.
if [ "$(id -u)" = 0 ] && [ "${1:-}" != "--health" ]; then
  chown 1001:0 /pbm
  exec setpriv --reuid=1001 --regid=0 --clear-groups bash "$0" "$@"
fi
: "${PBM_MONGODB_URI:?PBM_MONGODB_URI is required (set MONGODB_PBM_PASSWORD in .env, see gen-secrets.sh)}"
if [[ "$PBM_MONGODB_URI" == *"crew_pbm:@"* ]]; then
  # An .env from before point-in-time backups: say what to do instead of restarting over and over.
  msg="MONGODB_PBM_PASSWORD is not set in .env. Add MONGODB_PBM_PASSWORD=\$(openssl rand -hex 24) to .env and run: docker compose up -d --wait"
  [ "${1:-}" = "--health" ] && { echo "$msg"; exit 1; }
  while true; do echo "[pbm-start] $msg" >&2; sleep 3600; done
fi
BASE_HOURS="${PBM_BASE_BACKUP_HOURS:-24}"
KEEP_DAYS="${PBM_KEEP_DAYS:-14}"
SPAN_MIN="${PBM_OPLOG_SPAN_MIN:-10}"
STORE=/pbm
PAUSE="$STORE/.restore-in-progress"   # written by pitr-restore.sh: no backups or settings changes meanwhile
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [pbm-start] $*"; }

# Seconds since the last finished base backup, or a very large number when there is none.
last_backup_age() {
  local ts
  ts=$(pbm list --out json 2>/dev/null | jq -r '[.snapshots[]? | select(.status == "done") | .restoreTo] | max // empty')
  if [ -z "$ts" ]; then echo 999999999; else echo $(( $(date +%s) - ts )); fi
}

if [ "${1:-}" = "--health" ]; then
  [ -e "$PAUSE" ] && exit 0
  status=$(pbm status --out json 2>/dev/null) || { echo "pbm status failed"; exit 1; }
  echo "$status" | jq -e '[.cluster[]?.nodes[]? | select(.ok == true)] | length > 0' >/dev/null || { echo "agent not ready"; exit 1; }
  age=$(last_backup_age)
  [ "$age" -lt $(( BASE_HOURS * 3600 + 7200 )) ] || { echo "no finished base backup in the last $BASE_HOURS h"; exit 1; }
  # Slices are written every SPAN_MIN minutes; allow two missed ones before calling it unhealthy. Right after a base
  # backup there is no slice yet, and the backup itself counts.
  echo "$status" | jq -e --argjson max $(( SPAN_MIN * 180 + 300 )) --argjson now "$(date +%s)" --argjson base $(( $(date +%s) - age )) \
    '.pitr.conf == true and ([((.backups.pitrChunks.pitrChunks // []) | map(.range.end) | max // 0), $base] | max) > ($now - $max)' >/dev/null \
    || { echo "oplog slices are not current"; exit 1; }
  exit 0
fi

pbm-agent &
agent=$!
trap 'kill -TERM "$agent" 2>/dev/null; wait "$agent"; exit 0' TERM INT

config() {
  cat > /tmp/pbm-config.yaml <<YAML
storage:
  type: filesystem
  filesystem:
    path: $STORE
pitr:
  enabled: true
  oplogSpanMin: $SPAN_MIN
  compression: s2
backup:
  compression: s2
YAML
  pbm config --file /tmp/pbm-config.yaml >/dev/null
}

# The agent needs a few seconds to register before it takes commands.
for _ in $(seq 1 60); do
  kill -0 "$agent" 2>/dev/null || { log "pbm-agent stopped"; exit 1; }
  if [ ! -e "$PAUSE" ] && config 2>/dev/null; then break; fi
  sleep 2
done
log "settings stored: oplog slices every $SPAN_MIN min, base backup every $BASE_HOURS h, kept $KEEP_DAYS days"

last_cleanup=0
while kill -0 "$agent" 2>/dev/null; do
  if [ ! -e "$PAUSE" ]; then
    if [ "$(last_backup_age)" -ge $(( BASE_HOURS * 3600 )) ]; then
      log "taking a base backup"
      # Right after the agent starts PBM can still be electing a node; the next round tries again.
      if pbm backup --wait >/tmp/pbm-backup.log 2>&1; then log "$(tail -1 /tmp/pbm-backup.log)"; else log "base backup failed: $(tail -2 /tmp/pbm-backup.log | tr '\n' ' ')"; fi
    fi
    if [ $(( $(date +%s) - last_cleanup )) -ge 86400 ] && [ "$(last_backup_age)" -lt 999999999 ]; then
      # Keeps what is needed to restore to any time in the last KEEP_DAYS days.
      pbm cleanup --older-than "${KEEP_DAYS}d" --yes --wait >/dev/null 2>&1 && log "deleted backups older than $KEEP_DAYS days" || log "cleanup failed"
      last_cleanup=$(date +%s)
    fi
  fi
  sleep 60 & wait $! || true
done
log "pbm-agent stopped"
exit 1
