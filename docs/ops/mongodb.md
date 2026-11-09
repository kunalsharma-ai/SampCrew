# MongoDB

SampCrew stores everything in MongoDB 8.0. It moved from PostgreSQL in November 2026 (docs/phases/phase-20.md); the
PostgreSQL schema, its Row-Level Security and its triggers are carried over as rules the data layer enforces on
every read and write.

## Requirements

- MongoDB 8.0 as a **replica set** (one node is fine) or a **MongoDB Atlas** cluster. SampCrew writes each change and
  its audit event in one multi-document transaction, and a standalone `mongod` has no transactions. The API and the
  migration job refuse a standalone server and say why.
- `MONGODB_URL`, with the database name in its path: `mongodb://localhost:27017/crew?replicaSet=rs0`, or
  `mongodb+srv://user:password@cluster.xxxxx.mongodb.net/crew` for Atlas.
- `MONGODB_POOL_MAX` (default 20) sets the connections per API process.
- In staging and production the API refuses a URL without a database user and a real password, unless it signs in
  with `authMechanism=MONGODB-X509`, `MONGODB-AWS` or `MONGODB-OIDC`.

## Users

| User | Used by | Rights |
|---|---|---|
| `crew_api` (`MONGODB_API_PASSWORD`) | the API | `readWrite` on the SampCrew database, `clusterMonitor` for the Console's System health page. The migration job creates it and resets its password on every run. |
| admin (`MONGODB_ADMIN_URL`) | migrations, seed, backups, restore, the drill | creates collections, validators and indexes, and reads everything (the bundled server's `root`; on Atlas a user with `dbAdmin` and `readWrite` on the database plus `backup` / `restore`). |

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

## Backups and restore

`infra/deploy/scripts/backup.sh` writes a gzip `mongodump` archive of the database (encrypted with
`BACKUP_PASSPHRASE`), `restore.sh` restores it into a new, empty database and checks every validator and audit trail,
and `pnpm --filter @crew/db dr-drill` does a full backup and restore into a scratch database and compares them. On
Atlas, turn on continuous cloud backup as well; the archives are the portable second copy. See docs/ops/runbook.md.

## Not done yet

- A custom database role for the API that can only insert into `audit_events` (today the data layer refuses any
  change to it, and the hash chain shows one made outside SampCrew).
