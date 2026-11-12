# MongoDB

SampCrew stores everything in MongoDB 8.0. It moved from PostgreSQL in November 2026 (docs/phases/phase-20.md); the
PostgreSQL schema, its Row-Level Security and its triggers are carried over as rules the data layer enforces on
every read and write.

## Requirements

- MongoDB 8.0 as a **replica set** (one node is fine). Production runs it **self-hosted** next to the apps, from
  `infra/deploy/compose.yml` (next section); a **MongoDB Atlas** cluster also works (optional, last section). SampCrew
  writes each change and its audit event in one multi-document transaction, and a standalone `mongod` has no
  transactions. The API and the migration job refuse a standalone server and say why.
- `MONGODB_URL`, with the database name in its path: `mongodb://localhost:27017/crew?replicaSet=rs0`.
- `MONGODB_POOL_MAX` (default 20) sets the connections per API process.
- In staging and production the API refuses a URL without a database user and a real password, unless it signs in
  with `authMechanism=MONGODB-X509`, `MONGODB-AWS` or `MONGODB-OIDC`.

## Users

| User | Used by | Rights |
|---|---|---|
| `crew_api` (`MONGODB_API_PASSWORD`) | the API | `readWrite` on the SampCrew database, `clusterMonitor` for the Console's System health page. The migration job creates it and resets its password on every run. |
| `crew_pbm` (`MONGODB_PBM_PASSWORD`) | the `pbm` service (point-in-time backups) | the roles Percona Backup for MongoDB documents (`backup`, `restore`, `clusterMonitor`, `readWrite` on admin and the `pbmAnyAction` role). The migration job creates it. |
| admin (`MONGODB_ADMIN_URL`) | migrations, seed, backups, restore, the drill | creates collections, validators and indexes, and reads everything (the bundled server's `root`; on Atlas a user with `dbAdmin` and `readWrite` on the database plus `backup` / `restore`). |

`crew_api` also gets `crewBackupStatus`, a role of its own that can only read PBM's status collections
(`pbmBackups`, `pbmPITRChunks`, `pbmAgents`, `pbmRestores`; never `pbmConfig`), so the Console's System health page can
show how far back the database can be restored.

## Local

```sh
docker compose -f infra/docker/docker-compose.yml up -d mongo   # single-node replica set rs0, initiated on first start
export MONGODB_URL='mongodb://localhost:27017/crew?replicaSet=rs0'
pnpm db:migrate && pnpm db:seed                                  # collections, validators, indexes, catalogue, demo
pnpm db:reset                                                    # drop the database and do both again (never in staging or production)
```

Tests use their own database (its name must contain `test`), which they drop and recreate on each run:

```sh
pnpm build:packages
pnpm test          # the API against TEST_MONGODB_URL (default mongodb://127.0.0.1:27017/crew_test?replicaSet=rs0)
pnpm test:mongo    # the data layer itself
```

`infra/ci/start-mongo.sh` starts the same replica set in Docker, as CI does.

## How the PostgreSQL rules carry over

`packages/db/src/mongo/schema.generated.ts` lists every collection with its columns, defaults, enums, unique keys,
foreign keys, indexes, CHECK rules, grants and triggers. It was generated once from the PostgreSQL schema and is now
edited by hand, together with a new numbered migration in `packages/db/src/mongo/migrations`.

- **Workspace isolation**: `MongoService.tenant()` hands out tables that add the workspace to every filter and every
  inserted document, and refuse updates that would move a document to another workspace. Platform-only collections
  are not reachable from a workspace at all. This replaces Row-Level Security.
- **Types, required fields and CHECK rules** are in each collection's validator (`$jsonSchema` plus the CHECKs
  compiled to `$expr` by `checks.ts`), so the server itself refuses a bad document, whoever writes it.
- **Unique keys** are unique indexes (partial where PostgreSQL had a `where`); case-insensitive ones and keys across
  nullable columns use guard documents in `_unique_keys`, written in the same transaction.
- **Foreign keys** are checked on insert and update, and `on delete cascade / set null / restrict` applied on delete,
  including cross-workspace references, which are refused.
- **Triggers** (append-only tables, frozen payroll and reviews, anonymous survey answers, and the rest) are row guards
  in `row-guards.ts`, run for every write.
- **Audit trail**: `audit_events` is append-only and hash-chained per workspace (and once for the platform) with the
  same payload and hash as before, so older chains still verify. An event is written in the transaction that makes
  the change (so they commit or roll back together) and given its place in the chain by a short transaction right
  after the commit, before the API answers. Linking inside every write transaction made a busy workspace's
  transactions abort each other under snapshot isolation (the load test showed leave requests at 15 s). If the API
  stops between a commit and the linking, the outbox loop links what is left within a minute.
- **Counters** that every write in a workspace would touch (employee numbers) are taken in a short transaction of
  their own, like a sequence; a write that then fails leaves a gap.

## Writing data-layer code

- Use `MongoService` (`apps/api/src/platform/database/mongo.service.ts`), never the driver directly. A test fails if
  code outside `src/platform/database` imports `mongodb`, apart from type-only imports.
- Use UUID strings for ids (`_id` in storage, `id` in code). Field names keep the PostgreSQL column names
  (`tenant_id`, `full_name`, `created_at`), so API mapping code and audit records read the same.
- Updates use operators (`$set`, `$inc`, ...); a plain object is refused.
- A transaction callback can run more than once when MongoDB retries a write conflict. Keep side effects out of it,
  and queue email and webhooks through the outbox.
- Use `tx.audit(...)` for the audit trail, and `tx.defer(...)` for anything else that has to run last.
- Transactions read a snapshot taken at their first read. A second transaction opened inside one (`db.platform()`
  inside `db.tenant()`) commits on its own, and the outer one does not see what it wrote. Do the work in the same
  transaction; for a global record written from a workspace (a person's identity on invite), use
  `tx.unscoped(name)` at a reviewed call site.
- `$unionWith`, `$out` and `$merge` are not available in a workspace transaction. Use two queries.

## Self-hosted in production

`infra/deploy/compose.yml` runs the database on the SampCrew server itself. Nothing in it is reachable from outside:
MongoDB is only on the internal `data` network.

| Service | What it does |
|---|---|
| `mongo` | MongoDB 8.0, a replica set (`rs0`) with authentication and an internal key file (`MONGO_REPLICA_KEY`). The root user is created on the first start, the replica set the first time the health check runs (`scripts/mongo-start.sh`). Clean shutdown gets 60 seconds, the open-file limit is MongoDB's recommended 64000, the cache is `MONGO_CACHE_SIZE_GB`, and logs are rotated. |
| `pbm` | [Percona Backup for MongoDB](https://docs.percona.com/percona-backup-mongodb/) 2.17: a base backup every `PBM_BASE_BACKUP_HOURS` (24) and every change in between, saved in slices of `PBM_OPLOG_SPAN_MIN` minutes (10), kept `PBM_KEEP_DAYS` (14). The database can be put back to **any second** of that window (`scripts/pbm-start.sh`). |
| `backup` | Daily encrypted `mongodump` archives and uploaded-file archives (portable, restorable into a new database), and the copy of both, plus the point-in-time backups, to off-site storage (`scripts/backup.sh`). |
| `migrate` | Before every API start: migrations, and the `crew_api` and `crew_pbm` users. |

Settings in `.env` (all have working defaults; `env.production.example` explains each):

| Setting | Default | Notes |
|---|---|---|
| `MONGO_IMAGE` | `mongo:8.0` | Pin the exact release you run, e.g. `mongo:8.0.38`, and change it deliberately (below). |
| `MONGO_CACHE_SIZE_GB` | `2` | WiredTiger cache. About a quarter to a third of the host's memory when the apps share it. |
| `MONGO_REPLICA_HOST` | `mongo:27017` | The address this member announces. Set a DNS name before the first start if you will add members on other servers. |
| `PBM_BASE_BACKUP_HOURS`, `PBM_OPLOG_SPAN_MIN`, `PBM_KEEP_DAYS` | 24, 10, 14 | Point-in-time backups. The newest changes that can be lost in a disaster are the last `PBM_OPLOG_SPAN_MIN` minutes (plus `BACKUP_SYNC_MINUTES` if the server's disk is lost). |
| `BACKUP_REMOTE`, `BACKUP_REMOTE_KEEP_DAYS`, `BACKUP_SYNC_MINUTES` | empty, 30, 15 | Off-site copy (below). |
| `BACKUP_ALERT_WEBHOOK` | empty | Gets `{"text": "..."}` when a backup or an off-site copy fails. |

### Watching it

- **Console > System health** shows the replica set (each member's state, replication lag, how many hours of changes
  the oplog holds), the last archive (when, size, encrypted, copied off-site or not, the error if it failed) and the
  point-in-time window ("restorable to any second up to ..."). Missing pieces are listed under "Not configured".
- `docker compose ps`: `pbm` turns unhealthy when its agent is down, the last base backup is older than the interval
  or the oplog slices stop; `backup` turns unhealthy when the last archive or off-site copy failed or is overdue.
  Alert on unhealthy containers.
- `docker compose exec pbm pbm status` and `pbm logs` show PBM's own view.

### Off-site copy

A backup on the database's own disk does not survive losing that disk. Set `BACKUP_REMOTE` (an
[rclone](https://rclone.org) remote and path, e.g. `offsite:sampcrew-backups`) and put the storage account in
`infra/deploy/offsite.env` (copy `offsite.env.example`: Amazon S3, S3-compatible storage such as Backblaze B2, Wasabi
or Cloudflare R2, Azure Blob, or another server over SFTP). Only the backup service reads that file.

- Archives go to `<remote>/archives` (already encrypted with `BACKUP_PASSPHRASE`); point-in-time backups go to
  `<remote>/pbm` every `BACKUP_SYNC_MINUTES`, encrypted on the way (file contents and names, rclone `crypt` with a key
  from `BACKUP_PASSPHRASE`).
- Copies older than `BACKUP_REMOTE_KEEP_DAYS` (30) are deleted; set 0 when the bucket has its own lifecycle rule.
  Use a bucket with versioning and, where offered, object lock, and a key that can only write to that bucket.
- Check it: `docker compose run --rm backup rclone lsd offsite:` lists the remote, then
  `docker compose run --rm backup /app/infra/deploy/scripts/backup.sh` takes a backup and copies it.

### Point-in-time restore

Put the SampCrew database back to its state at a given second (UTC), for example just before a bad import or a
mistaken bulk delete. Only the `crew` database changes; database users and other databases stay as they are.

```sh
docker compose exec pbm /crew/pitr-restore.sh list                       # the restorable window, in UTC
docker compose stop api backup                                           # nothing may write during the restore
docker compose exec pbm /crew/pitr-restore.sh 2026-11-12T09:41:00 --yes  # or a snapshot name from the list
docker compose up -d --wait                                              # migrations, then the API and backups
docker compose run --rm migrate sh -c 'cd /app/db && ./node_modules/.bin/tsx scripts/restore-check.ts'
```

The script keeps the state just before the restore as a base backup first (so a restore to the wrong second can be
undone the same way), restores, takes a fresh base backup and switches point-in-time saving back on. A restore of the
demo database took about a minute. Uploaded files are not part of it: they are in the daily `crew-files-*` archives.
The CI smoke test runs exactly these steps on every change.

### Losing the server

1. Build a new server with the same `.env` and `offsite.env` (keep both in your password manager), and
   `docker compose up -d --wait`. MongoDB starts empty.
2. Bring the point-in-time backups back and let PBM read them:
   ```sh
   docker compose stop api backup
   docker compose run --rm --user 1001:0 -v crew_pbm:/pbm-restore -e PBM_DIR=/pbm-restore \
     backup /app/infra/deploy/scripts/backup.sh --fetch-pbm      # as PBM's user, into the pbm volume
   docker compose exec pbm pbm config --force-resync
   docker compose exec pbm /crew/pitr-restore.sh list
   ```
3. Restore to the newest time in the list (`pitr-restore.sh <time> --yes`), then `docker compose up -d --wait` and
   the restore check. Without point-in-time backups, restore the newest archive instead (runbook section 5).
   This whole sequence was rehearsed on a stack whose volumes were all deleted: the data came back to the last
   second copied off-site, with every validator and audit trail intact.
4. Restore the uploaded files from the newest `crew-files-*` archive.

### More members (failover)

One member has no automatic failover: if its server stops, SampCrew stops. For failover run three members on three
servers (one can be a small one). On every server, start `mongod` with the same `MONGO_REPLICA_KEY` and replica set
name, reachable on port 27017 only from the other members and the SampCrew server (firewall or private network), with
TLS between servers. Then, from the bundled member:

```sh
docker compose exec mongo mongosh -u root -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin \
  --eval 'rs.add("db2.crew.internal:27017"); rs.add("db3.crew.internal:27017")'
```

The bundled member must announce an address the others can reach (`MONGO_REPLICA_HOST`, set before the first start;
change it later with `rs.reconfig`). Each new member copies the data, then shows as `secondary` on System health.
Run a PBM agent next to every member (`pbm` service, `PBM_MONGODB_URI` pointing at that member) and use shared
storage for PBM (for example S3 via `pbm config --file`), as PBM requires.

### Upgrading MongoDB

- Patch releases (8.0.x): take a backup (`docker compose run --rm backup /app/infra/deploy/scripts/backup.sh`), set
  `MONGO_IMAGE=mongo:8.0.<new>`, `docker compose up -d --wait mongo`. With three members, upgrade the secondaries first,
  then `rs.stepDown()` the primary and upgrade it.
- Major releases (8.0 to 8.2 or 9.0): follow MongoDB's upgrade notes, one major release at a time, and set
  `featureCompatibilityVersion` only after the apps have run on the new release for a while. Check that the PBM release
  in `PBM_IMAGE` supports it first.

## Backups and restore

`infra/deploy/scripts/backup.sh` writes a gzip `mongodump` archive of the database (encrypted with
`BACKUP_PASSPHRASE`), `restore.sh` restores it into a new, empty database and checks every validator and audit trail,
and `pnpm --filter @crew/db dr-drill` does a full backup and restore into a scratch database and compares them. On the
self-hosted database the `pbm` service adds point-in-time recovery (above); the archives are the portable second copy,
restorable into another database or another MongoDB entirely. See docs/ops/runbook.md.

## MongoDB Atlas (optional)

SampCrew also runs on a MongoDB Atlas cluster (MongoDB 8.0, M10 or larger for production). In Atlas create two
database users: `crew-api` with `readWrite` on `crew` plus `clusterMonitor`, and `crew-admin` with
`readWriteAnyDatabase` and `dbAdminAnyDatabase` (restores and the drill write new databases). In `.env` set
`MONGODB_URL` and `MONGODB_ADMIN_URL` to their `mongodb+srv://` URLs (database `crew` in the path), delete the
`MONGODB_API_PASSWORD` and `MONGODB_PBM_PASSWORD` lines (Atlas manages its users), and start without the bundled
database and its point-in-time agent:

```sh
docker compose up -d --wait --scale mongo=0 --scale pbm=0
```

Turn on Atlas Continuous Cloud Backup for point-in-time recovery; the daily archives and their off-site copy keep
working. Switching between self-hosted and Atlas later is one backup and restore. The CI smoke test runs the
self-hosted stack only, so check the first Atlas start carefully.

## Not done yet

- A custom database role for the API that can only insert into `audit_events` (today the data layer refuses any
  change to it, and the hash chain shows one made outside SampCrew).
