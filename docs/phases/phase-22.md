# Phase 22 report: self-hosted MongoDB in production

Kunal chose (12 November 2026) to run MongoDB self-hosted rather than on MongoDB Atlas. The deploy stack already ran
a bundled one-node replica set; this phase makes it the finished production default. The gaps against a managed
database were point-in-time recovery, an off-site copy, alerts when backups stop, and operating settings for the
database itself. Atlas stays possible as an optional, documented setup.

## Working end to end

- **Point-in-time recovery.** A new `pbm` service runs Percona Backup for MongoDB 2.17 next to the database. It takes a
  base backup every day and saves every change in between, in 10-minute slices. The database can be put back to any
  second of the last 14 days with `scripts/pitr-restore.sh`. Only the `crew` database is restored; database users and
  other databases stay as they are. The state just before a restore is kept as a backup, so a restore to the wrong
  second can be undone. Afterwards the script takes a fresh base backup and switches point-in-time saving back on.
- **Off-site copy.** With `BACKUP_REMOTE` set, the backup service copies the daily archives and the point-in-time
  backups off the server with rclone. The storage account goes in `offsite.env` (S3, S3-compatible storage, Azure
  Blob or SFTP), and only the backup service reads that file. Archives are already encrypted. Point-in-time backups
  are encrypted on the way, names included, with a key from `BACKUP_PASSPHRASE`. Old copies are pruned after
  `BACKUP_REMOTE_KEEP_DAYS`.
- **Disaster recovery.** `backup.sh --fetch-pbm` brings the point-in-time backups back onto a new server. The steps
  were rehearsed on a stack whose volumes had all been deleted, and the data came back with every validator and
  audit trail intact (docs/ops/mongodb.md, "Losing the server").
- **Backup status and alerts.**
  - Each archive run is recorded in a new platform collection, `backup_runs`.
  - Console > System health has a **Backups** card. It shows the last archive (when, size, encrypted, copied
    off-site, and the error if it failed) and the point-in-time window. That window is read from PBM's own status
    collections through a read-only role, `crewBackupStatus`, which cannot read PBM's settings.
  - A **Replica set** card shows each member's state, replication lag and how many hours of changes the oplog holds.
  - Missing pieces (no off-site copy, no point-in-time backups) are listed under "Not configured".
  - The `backup` and `pbm` containers turn unhealthy when backups fail or fall behind.
  - `BACKUP_ALERT_WEBHOOK` gets a `{"text": ...}` message, which suits Slack, Teams and Google Chat.
- **Database settings.**
  - `MONGO_CACHE_SIZE_GB` caps the WiredTiger cache (default 2 GB for the 8 GB host in the runbook).
  - The open-file limit is 64000.
  - mongod gets 60 seconds to shut down cleanly.
  - `MONGO_REPLICA_HOST` sets the address the member announces, so members can be added later.
  - Container logs are rotated for every service.
  - The migration job creates the PBM user (`crew_pbm`, from `MONGODB_PBM_PASSWORD`, which `gen-secrets.sh` now
    generates).
- **Atlas without editing compose.yml.** The migration job's wait for the bundled database is no longer required, so
  `docker compose up -d --scale mongo=0 --scale pbm=0` is the whole switch.

## Tests

- **CI smoke test** (`infra/deploy/smoke.sh`, job `deploy`). It now also checks:
  - The off-site copy arrives, and the point-in-time files there are encrypted.
  - The backup service reports healthy.
  - `crew_api` can read the backup status but not PBM's settings.
  - A full point-in-time restore: change a record, note the second, delete data, wait for the oplog slice, stop the
    API, restore, check that the record and the deleted rows are back, start again, and run the restore check.
- **`apps/api/test/platform.spec.ts`** checks the new System health readings: replica set members and oplog window,
  last backup, failed backup with the last good one, the off-site flag, and the point-in-time window read from PBM's
  status collections.
- **Run locally against the real images** (MongoDB 8.0.38 and PBM 2.17.0): `compose.yml` with the `mongo`,
  `migrate`, `pbm` and `backup` services, a point-in-time restore, an off-site copy to an S3 server, the failure
  alert, and disaster recovery from the off-site copy after deleting every volume. The tools image itself could not be
  built in the sandbox (Alpine's package server is blocked there), so the CI run is its first build.
- The full API suite (476 tests), the data-layer tests (42) and every package's tests pass.

## Not yet working

- **Failover needs three members.** One member still has no automatic failover. Adding members on other servers is
  documented (docs/ops/mongodb.md, "More members") but has not been rehearsed. With several members, PBM also needs
  an agent per member and shared storage.
- **Uploaded files are daily only.** Point-in-time recovery covers the database. Uploaded files are still in the
  daily `crew-files-*` archives.
- **No tested MongoDB upgrade.** A major MongoDB upgrade (8.0 to 8.2 or 9.0) has not been tested. The procedure is
  documented.
- **Atlas was not rerun.** The optional Atlas path was not run against a real Atlas cluster in this phase.
