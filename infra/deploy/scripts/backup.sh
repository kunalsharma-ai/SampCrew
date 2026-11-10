#!/bin/sh
# Database and uploaded-file backups.
#
#   backup.sh            one backup now
#   backup.sh --loop     a backup every BACKUP_INTERVAL_HOURS (default 24), for the compose "backup" service
#
# Writes to BACKUP_DIR (default /backups):
#   crew-db-<UTC time>.archive.gz   mongodump archive (gzip) of the database named in MONGODB_URL (restore with restore.sh)
#   crew-files-<UTC time>.tar.gz    the uploaded files in FILES_DIR (default /data/files), when that folder exists
# Each collection is copied consistently, but writes made while the dump runs can land in some collections and not
# others. That is fine for a daily safety copy; for point-in-time recovery use the cluster's own continuous backup
# (MongoDB Atlas, or Ops Manager / filesystem snapshots on a self-hosted replica set) alongside these files.
# With BACKUP_PASSPHRASE set, both are encrypted (AES-256-GCM, key from scrypt) and end in .enc.
# Backups older than BACKUP_KEEP_DAYS (default 14) are deleted. Copy BACKUP_DIR off the server as well: a backup
# on the same disk as the database does not survive losing that disk.
set -eu
: "${MONGODB_URL:?MONGODB_URL is required (a user that can read every collection, e.g. the admin URL)}"
DIR="${BACKUP_DIR:-/backups}"
FILES="${FILES_DIR:-/data/files}"
KEEP="${BACKUP_KEEP_DAYS:-14}"

encrypt() { # $1 = file; replaces it with $1.enc
  if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    node "$(dirname "$0")/crypt.mjs" encrypt "$1" "$1.enc"
    rm -f "$1"
  fi
}

once() {
  mkdir -p "$DIR"
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  db="$DIR/crew-db-$stamp.archive.gz"
  mongodump --quiet --uri="$MONGODB_URL" --archive="$db.partial" --gzip
  mv "$db.partial" "$db"
  encrypt "$db"
  if [ -d "$FILES" ]; then
    tar -czf "$DIR/crew-files-$stamp.tar.gz.partial" -C "$FILES" .
    mv "$DIR/crew-files-$stamp.tar.gz.partial" "$DIR/crew-files-$stamp.tar.gz"
    encrypt "$DIR/crew-files-$stamp.tar.gz"
  fi
  find "$DIR" -maxdepth 1 -name 'crew-*' -type f -mtime "+$KEEP" -print -delete | sed 's/^/deleted old backup /'
  echo "backup $stamp done: $(ls -1 "$DIR" | grep -c "$stamp") file(s) in $DIR"
}

if [ "${1:-}" = "--loop" ]; then
  hours="${BACKUP_INTERVAL_HOURS:-24}"
  while true; do
    once || echo "backup failed; retrying at the next interval" >&2
    sleep $((hours * 3600))
  done
else
  once
fi
