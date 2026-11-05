# Backup and restore drill

- Run at: 2026-11-01T07:57:55.923Z
- Source database: crew on localhost
- PostgreSQL: 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
- Backup: 0.66 MB in 0.2 s (pg_dump custom format)
- Restore into a new database: 1.9 s
- Tables: 133 in the source, 133 restored; 1,520 rows compared
- Row-Level Security: enabled and forced on every table with a tenant_id
- Audit trail: 12 entries across 1 workspaces checked; every hash chain intact
- Migrations: same history (10 applied)
- Measured recovery time for this data: 2.2 s (backup plus restore; excludes provisioning a server and switching traffic)

**Result: passed.** The restored copy is complete, isolated per workspace and its audit trail verifies.
