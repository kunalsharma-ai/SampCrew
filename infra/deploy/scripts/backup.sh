#!/bin/sh
# Database and uploaded-file backups, and their copy off the server.
#
#   backup.sh            one backup now (and the off-site copy, when BACKUP_REMOTE is set)
#   backup.sh --loop     for the compose "backup" service: a backup every BACKUP_INTERVAL_HOURS (default 24), and
#                        every BACKUP_SYNC_MINUTES (default 15) the point-in-time backups in /pbm copied off-site
#   backup.sh --check    health check: fails when the last backup failed or is older than the interval allows
#   backup.sh --fetch-pbm  copies the point-in-time backups back from BACKUP_REMOTE (disaster recovery)
#
# Writes to BACKUP_DIR (default /backups):
#   crew-db-<UTC time>.archive.gz   mongodump archive (gzip) of the database named in MONGODB_URL (restore with restore.sh)
#   crew-files-<UTC time>.tar.gz    the uploaded files in FILES_DIR (default /data/files), when that folder exists
# Each collection is copied consistently, but writes made while the dump runs can land in some collections and not
# others. That is fine for a portable daily copy; point-in-time recovery comes from the "pbm" service
# (pbm-start.sh) on the bundled database, or from the cluster's own continuous backup on MongoDB Atlas.
# With BACKUP_PASSPHRASE set, both are encrypted (AES-256-GCM, key from scrypt) and end in .enc.
# Backups older than BACKUP_KEEP_DAYS (default 14) are deleted here.
#
# Off-site copy (strongly recommended: a backup on the database's own disk does not survive losing that disk):
#   BACKUP_REMOTE             an rclone remote and path, e.g. offsite:sampcrew-backups. The remote itself is set with
#                             RCLONE_CONFIG_<NAME>_* variables in offsite.env (S3, Backblaze B2, Azure Blob, Google
#                             Cloud Storage, SFTP and more: https://rclone.org/docs/#config-file). Archives go to
#                             <remote>/archives, point-in-time backups (PBM_DIR, default /pbm) to <remote>/pbm,
#                             encrypted with BACKUP_PASSPHRASE (names too) when it is set.
#   BACKUP_REMOTE_KEEP_DAYS   delete off-site copies older than this (default 30; 0 keeps them, e.g. when the bucket
#                             has its own lifecycle rule or retention lock)
# Each run is recorded in the database (backup_runs) for the Console's System health page. On a failure, a JSON
# message {"text": "..."} is posted to BACKUP_ALERT_WEBHOOK when set (Slack, Teams and Google Chat accept it).
set -eu
DIR="${BACKUP_DIR:-/backups}"
FILES="${FILES_DIR:-/data/files}"
PBM="${PBM_DIR:-/pbm}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
HOURS="${BACKUP_INTERVAL_HOURS:-24}"
REMOTE="${BACKUP_REMOTE:-}"
REMOTE_KEEP="${BACKUP_REMOTE_KEEP_DAYS:-30}"
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="$DIR/.last-run"   # "ok <epoch>" or "failed <epoch> <reason>"
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [backup] $*"; }

if [ "${1:-}" = "--check" ]; then
  [ -f "$STATE" ] || { echo "no backup has run yet"; exit 1; }
  read -r result at _ < "$STATE"
  [ "$result" = ok ] || { cat "$STATE"; exit 1; }
  age=$(( $(date +%s) - at ))
  [ "$age" -le $(( HOURS * 3600 + 7200 )) ] || { echo "last backup is $((age / 3600)) h old"; exit 1; }
  exit 0
fi

: "${MONGODB_URL:?MONGODB_URL is required (a user that can read every collection, e.g. the admin URL)}"

encrypt() { # $1 = file; replaces it with $1.enc and prints the new name
  if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    node "$HERE/crypt.mjs" encrypt "$1" "$1.enc"
    rm -f "$1"
    echo "$1.enc"
  else
    echo "$1"
  fi
}

alert() {
  [ -n "${BACKUP_ALERT_WEBHOOK:-}" ] || return 0
  ALERT_TEXT="SampCrew backup on $(hostname): $1" node -e '
    fetch(process.env.BACKUP_ALERT_WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: process.env.ALERT_TEXT }), signal: AbortSignal.timeout(15000) })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); })
      .catch((e) => { console.error("could not send the backup alert: " + e.message); });' || true
}

# The point-in-time backups are not encrypted by PBM, so with BACKUP_PASSPHRASE set they go off-site through an rclone
# "crypt" remote: file contents and names encrypted with a key derived from the passphrase (https://rclone.org/crypt/).
pbm_remote() { # sets PBM_TARGET (and the crypt remote's settings) in this shell
  if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    export RCLONE_CONFIG_CREWPBM_TYPE=crypt RCLONE_CONFIG_CREWPBM_REMOTE="$REMOTE/pbm"
    RCLONE_CONFIG_CREWPBM_PASSWORD=$(printf '%s' "$BACKUP_PASSPHRASE" | rclone obscure -)
    RCLONE_CONFIG_CREWPBM_PASSWORD2=$(printf '%s' "crew-pbm-salt:$BACKUP_PASSPHRASE" | rclone obscure -)
    export RCLONE_CONFIG_CREWPBM_PASSWORD RCLONE_CONFIG_CREWPBM_PASSWORD2
    PBM_TARGET="crewpbm:"
  else
    PBM_TARGET="$REMOTE/pbm"
  fi
}

# rclone exits non-zero on any file it could not copy; its last lines say why.
offsite() { # copies the archives and the point-in-time backups to BACKUP_REMOTE
  [ -n "$REMOTE" ] || return 0
  : > "$DIR/.rclone.log"
  rc() { rclone "$@" --log-level ERROR 2>>"$DIR/.rclone.log"; }
  # mkdir first: listing (for the age-based delete) a folder that does not exist yet is an error on some remotes.
  rc mkdir "$REMOTE/archives" || return 1
  rc copy "$DIR" "$REMOTE/archives" --filter '- *.partial' --filter '+ crew-*' --filter '- *' || return 1
  if [ -d "$PBM" ]; then
    pbm_remote
    rc mkdir "$PBM_TARGET" || return 1
    rc copy "$PBM" "$PBM_TARGET" --filter '- /.restore-in-progress' || return 1
  fi
  if [ "$REMOTE_KEEP" -gt 0 ]; then
    rc delete "$REMOTE/archives" --min-age "${REMOTE_KEEP}d" || return 1
    [ -d "$PBM" ] && { pbm_remote; rc delete "$PBM_TARGET" --min-age "${REMOTE_KEEP}d" --filter '- /.pbm.init' || return 1; }
  fi
  return 0
}

record() { # JSON for backup_runs; a failure to record is printed, never fatal
  (cd /app/db && ./node_modules/.bin/tsx scripts/backup-record.ts "$1") || true
}

once() {
  mkdir -p "$DIR"
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  db="$DIR/crew-db-$stamp.archive.gz"
  status=ok error="" dbfile="" dbbytes=0 filesfile="" filesbytes=0
  if mongodump --quiet --uri="$MONGODB_URL" --archive="$db.partial" --gzip 2>"$DIR/.dump.log"; then
    mv "$db.partial" "$db"
    dbfile=$(encrypt "$db")
    dbbytes=$(stat -c %s "$dbfile")
  else
    rm -f "$db.partial"
    status=failed error="database dump failed: $(tail -c 400 "$DIR/.dump.log" | tr '\n"\\' '   ')"
  fi
  if [ "$status" = ok ] && [ -d "$FILES" ]; then
    f="$DIR/crew-files-$stamp.tar.gz"
    if tar -czf "$f.partial" -C "$FILES" . 2>"$DIR/.dump.log"; then
      mv "$f.partial" "$f"
      filesfile=$(encrypt "$f")
      filesbytes=$(stat -c %s "$filesfile")
    else
      rm -f "$f.partial"
      status=failed error="file archive failed: $(tail -c 400 "$DIR/.dump.log" | tr '\n"\\' '   ')"
    fi
  fi
  find "$DIR" -maxdepth 1 -name 'crew-*' -type f -mtime "+$KEEP" -print -delete | sed 's/^/deleted old backup /'

  copy=off copyerror=""
  if [ -n "$REMOTE" ]; then
    if offsite; then copy=copied; else copy=failed copyerror="$(tail -c 400 "$DIR/.rclone.log" | tr '\n"\\' '   ')"; fi
  fi
  enc=false
  [ -n "${BACKUP_PASSPHRASE:-}" ] && enc=true
  record "$(printf '{"started_at":"%s","status":"%s","encrypted":%s,"db_file":%s,"db_bytes":%s,"files_file":%s,"files_bytes":%s,"offsite":"%s","error":%s,"offsite_error":%s}' \
    "$started" "$status" "$enc" "$(json "$(basename "$dbfile")")" "$dbbytes" "$(json "$(basename "$filesfile")")" "$filesbytes" "$copy" "$(json "$error")" "$(json "$copyerror")")"

  if [ "$status" = ok ] && [ "$copy" != failed ]; then
    echo "ok $(date +%s)" > "$STATE"
    log "backup $stamp done: $(basename "$dbfile")${filesfile:+, $(basename "$filesfile")}$( [ "$copy" = copied ] && echo ", copied to $REMOTE")"
    return 0
  fi
  reason="${error:-off-site copy to $REMOTE failed: $copyerror}"
  echo "failed $(date +%s) $reason" > "$STATE"
  log "backup $stamp FAILED: $reason" >&2
  alert "$reason"
  return 1
}

json() { # a JSON string, or null when empty
  if [ -z "$1" ]; then echo null; else printf '"%s"' "$(printf '%s' "$1" | sed 's/["\\]/ /g')"; fi
}

if [ "${1:-}" = "--fetch-pbm" ]; then
  # Brings the point-in-time backups back from BACKUP_REMOTE into PBM_DIR (after losing the server or its disk). Run
  # it as PBM's user (uid 1001) with the pbm volume mounted read-write, then `pbm config --force-resync` in the pbm
  # service. See docs/ops/mongodb.md, "Losing the server".
  [ -n "$REMOTE" ] || { echo "BACKUP_REMOTE is not set" >&2; exit 1; }
  pbm_remote
  rclone copy "$PBM_TARGET" "$PBM" --log-level NOTICE
  echo "point-in-time backups copied into $PBM"
  exit 0
fi

if [ "${1:-}" = "--loop" ]; then
  sync_every=$(( ${BACKUP_SYNC_MINUTES:-15} * 60 ))
  next_backup=0 last_alert=0
  while true; do
    now=$(date +%s)
    if [ "$now" -ge "$next_backup" ]; then
      # After a failure, try again in an hour rather than a whole interval later.
      if once; then next_backup=$(( now + HOURS * 3600 )); else next_backup=$(( now + 3600 )); fi
    elif [ -n "$REMOTE" ] && [ -d "$PBM" ]; then
      if ! offsite; then
        log "off-site copy of point-in-time backups failed: $(tail -c 300 "$DIR/.rclone.log")" >&2
        # One alert an hour at most while it keeps failing.
        if [ $(( now - last_alert )) -ge 3600 ]; then alert "off-site copy of point-in-time backups to $REMOTE failed"; last_alert=$now; fi
      fi
    fi
    sleep "$sync_every"
  done
else
  once
fi
