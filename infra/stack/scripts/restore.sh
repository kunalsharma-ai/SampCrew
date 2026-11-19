#!/bin/sh
# Restores a database backup made by backup.sh into an EMPTY database, then checks it.
#
#   RESTORE_MONGODB_URL=mongodb://root:...@mongo:27017/crew_restored?replicaSet=rs0&authSource=admin \
#     restore.sh /backups/crew-db-<time>.archive.gz[.enc]
#
# RESTORE_MONGODB_URL defaults to MONGODB_URL; the path names the target database. The target must be empty: this
# script never overwrites a database. After the restore it applies any newer migrations, sets the API's database
# user in the target (MONGODB_API_PASSWORD, when set), and checks that every collection has its validator and every
# audit trail (each workspace's and the platform's) verifies.
# Uploaded files: extract crew-files-<time>.tar.gz into the API's STORAGE_DIR.
set -eu
FILE="${1:?usage: restore.sh <backup file>}"
TARGET="${RESTORE_MONGODB_URL:-${MONGODB_URL:?set RESTORE_MONGODB_URL or MONGODB_URL}}"
check() { (cd /app/db && MONGODB_URL="$TARGET" ./node_modules/.bin/tsx scripts/restore-check.ts "$@"); }

check --must-be-empty

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
src="$FILE"
case "$FILE" in
  *.enc)
    : "${BACKUP_PASSPHRASE:?this backup is encrypted; set BACKUP_PASSPHRASE}"
    node "$(dirname "$0")/crypt.mjs" decrypt "$FILE" "$work/backup.archive.gz"
    src="$work/backup.archive.gz"
    ;;
esac

# The archive holds one database under its original name; restore it under the target's name.
target_db=$(check --print-database)
mongorestore --quiet --uri="$(check --print-server-url)" --archive="$src" --gzip --stopOnError --nsFrom='$db$.$coll$' --nsTo="$target_db.\$coll\$"

MONGODB_URL="$TARGET" /app/infra/deploy/scripts/migrate.sh
check
