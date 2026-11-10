# Backup and restore drill

- Run at: 2026-11-09T13:45:01.301Z
- Source database: crew on 127.0.0.1
- MongoDB: 8.0.34
- Backup: 0.12 MB in 0.9 s (mongodump archive, gzip)
- Restore into a new database: 5.0 s
- Collections: 167 in the source, 167 restored; 1,590 documents compared
- Validators and indexes: every collection has the same validator and indexes as the source
- Audit trail: 1 entries across 1 workspaces and the platform checked; every hash chain intact
- Migrations: same history (1 applied)
- Measured recovery time for this data: 6.0 s (backup plus restore; excludes provisioning a server and switching traffic)

**Result: passed.** The restored copy is complete, keeps every rule and index, and its audit trail verifies.
