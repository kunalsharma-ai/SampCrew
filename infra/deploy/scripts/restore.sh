#!/bin/sh
# Restores a database backup made by backup.sh into an EMPTY database, then checks it.
#
#   RESTORE_DATABASE_URL=postgres://admin:...@host:5432/crew_restored restore.sh /backups/crew-db-<time>.dump[.enc]
#
# RESTORE_DATABASE_URL defaults to DATABASE_ADMIN_URL. The target must exist and have no tables: this script never
# overwrites a database. After the restore it applies any newer migrations, sets the API login's password
# (DATABASE_API_PASSWORD) and verifies Row-Level Security and every workspace's audit trail.
# DATABASE_API_PASSWORD must be the password the running API uses: roles belong to the whole server, so restoring
# next to a live database on the same server sets the API login's password for both.
# Uploaded files: extract crew-files-<time>.tar.gz into the API's STORAGE_DIR.
set -eu
FILE="${1:?usage: restore.sh <backup file>}"
TARGET="${RESTORE_DATABASE_URL:-${DATABASE_ADMIN_URL:?set RESTORE_DATABASE_URL or DATABASE_ADMIN_URL}}"
: "${DATABASE_API_PASSWORD:?DATABASE_API_PASSWORD is required}"

tables=$(psql "$TARGET" -Atc "select count(*) from pg_tables where schemaname = 'public'")
if [ "$tables" != "0" ]; then
  echo "refusing to restore: the target database already has $tables tables. Restore into a new, empty database." >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
src="$FILE"
case "$FILE" in
  *.enc)
    : "${BACKUP_PASSPHRASE:?this backup is encrypted; set BACKUP_PASSPHRASE}"
    node "$(dirname "$0")/crypt.mjs" decrypt "$FILE" "$work/backup.dump"
    src="$work/backup.dump"
    ;;
esac

# Roles live outside the database, so a new server needs them before the grants in the backup can be restored.
psql "$TARGET" -v ON_ERROR_STOP=1 -q <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'crew_app') then create role crew_app nologin nobypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'crew_platform') then create role crew_platform nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'crew_api') then create role crew_api login noinherit; end if;
end $$;
grant crew_app to crew_api;
grant crew_platform to crew_api;
SQL

pg_restore --no-owner --exit-on-error --dbname="$TARGET" "$src"
echo "restored $(psql "$TARGET" -Atc "select count(*) from pg_tables where schemaname = 'public'") tables"

DATABASE_ADMIN_URL="$TARGET" /app/infra/deploy/scripts/migrate.sh

gaps=$(psql "$TARGET" -Atc "select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','p')
    and exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'tenant_id')
    and not (c.relrowsecurity and c.relforcerowsecurity)")
if [ -n "$gaps" ]; then echo "check failed: Row-Level Security is not forced on: $gaps" >&2; exit 1; fi
broken=$(psql "$TARGET" -Atc "select count(*) from tenants t cross join lateral audit_verify_chain(t.id) v where v.first_broken_seq is not null")
if [ "$broken" != "0" ]; then echo "check failed: $broken workspace audit trail(s) do not verify" >&2; exit 1; fi
echo "restore verified: Row-Level Security forced on every workspace table, every audit trail intact"
