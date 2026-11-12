#!/bin/bash
# Point-in-time restore of the SampCrew database from Percona Backup for MongoDB (the "pbm" service). Run it in that
# service, with the API and the backup service stopped:
#
#   docker compose stop api backup
#   docker compose exec pbm /crew/pitr-restore.sh list                         what can be restored (UTC times)
#   docker compose exec pbm /crew/pitr-restore.sh 2026-11-12T09:41:00 --yes    the database as it was at that second
#   docker compose up -d --wait                                                migrations, then the API again
#
# It puts back the SampCrew database (CREW_DATABASE, default crew) only: the database users and the other databases on
# the server are left alone. The state right before the restore is kept as a new base backup first, so a restore to
# the wrong time can itself be undone. PBM needs a base backup after a restore before point-in-time saving resumes;
# this script takes it and switches point-in-time saving back on.
set -euo pipefail
DBNAME="${CREW_DATABASE:-crew}"
PAUSE=/pbm/.restore-in-progress
log() { echo "[pitr-restore] $*"; }

case "${1:-}" in
  ""|-h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  list)
    pbm list
    echo
    echo "Restore to any time inside a \"PITR\" range above (UTC), or to a snapshot by its name."
    exit 0 ;;
esac

TARGET="$1"
if [ "${2:-}" != "--yes" ]; then
  echo "This replaces every collection in the $DBNAME database with its state at $TARGET (UTC)." >&2
  echo "Stop the API and the backup service first (docker compose stop api backup), then add --yes." >&2
  exit 2
fi
if [[ "$TARGET" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z?$ ]]; then
  what=(--time="${TARGET%Z}")
elif pbm list --out json | jq -e --arg n "$TARGET" '.snapshots[]? | select(.name == $n and .status == "done")' >/dev/null; then
  what=("$TARGET")
else
  echo "\"$TARGET\" is neither a time like 2026-11-12T09:41:00 nor a finished snapshot. See: pitr-restore.sh list" >&2
  exit 2
fi

touch "$PAUSE"
trap 'rm -f "$PAUSE"' EXIT
log "pausing point-in-time saving"
pbm config --set pitr.enabled=false >/dev/null
for _ in $(seq 1 60); do
  [ "$(pbm status --out json | jq -r '.pitr.run')" = "false" ] && break
  sleep 2
done

log "keeping the current state as a base backup first"
pbm backup --wait | tail -1

log "restoring $DBNAME to ${TARGET}"
pbm restore "${what[@]}" --ns="$DBNAME.*" --yes --wait | tail -2

log "taking a new base backup and switching point-in-time saving back on"
pbm backup --wait | tail -1
pbm config --set pitr.enabled=true >/dev/null
log "done. Now run: docker compose up -d --wait   (applies migrations, starts the API and backups)"
log "and check the data: docker compose run --rm migrate sh -c 'cd /app/db && ./node_modules/.bin/tsx scripts/restore-check.ts'"
