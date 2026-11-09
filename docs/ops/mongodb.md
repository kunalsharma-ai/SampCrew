# MongoDB

SampCrew is moving from PostgreSQL to MongoDB one group of modules at a time (docs/phases/phase-20.md). Until the cut-over, PostgreSQL still serves every feature and MongoDB is optional.

## Requirements

- MongoDB 8.0 running as a **replica set**. A single node is fine. SampCrew writes each change and its audit event in one multi-document transaction, and a standalone `mongod` has no transactions. The API refuses to start using a standalone server and says why.
- `MONGODB_URL`, with the database name in its path: `mongodb://localhost:27017/crew?replicaSet=rs0`, or a `mongodb+srv://` URL for MongoDB Atlas.
- `MONGODB_POOL_MAX` (default 20) sets the connections per API process.

## Local

```sh
docker compose -f infra/docker/docker-compose.yml up -d mongo   # single-node replica set rs0, initiated on first start
export MONGODB_URL='mongodb://localhost:27017/crew?replicaSet=rs0'
pnpm db:migrate:mongo                                            # collections, validators, indexes
```

Tests use their own database (its name must contain `test`), which they drop and recreate on each run:

```sh
pnpm build:packages
TEST_MONGODB_URL='mongodb://localhost:27017/crew_test?replicaSet=rs0' pnpm test:mongo
```

## Writing data-layer code

- Use `MongoService` (`apps/api/src/platform/database/mongo.service.ts`), never the driver directly. A test fails if code outside `src/platform/database` imports `mongodb`, apart from type-only imports.
- Register every new collection in `packages/db/src/mongo/collections.ts` (`tenant`, `shared` or `platform`). Create it in a new numbered migration in `packages/db/src/mongo/migrations` with a validator and tenant-first indexes (`{ tenant_id: 1, ... }`).
- Use UUID strings for `_id` (`randomUUID()`), not ObjectIds. Field names keep the PostgreSQL column names (`tenant_id`, `full_name`, `created_at`), so API mapping code and audit records read the same.
- A transaction callback can run more than once when MongoDB retries a write conflict. Keep side effects out of it, and queue email and webhooks through the outbox.
- Use `tx.audit(...)` for the audit trail, and `tx.defer(...)` for anything else that has to run last.
- Transactions read a snapshot taken at their first read. A second transaction opened inside one (`db.platform()` inside `db.tenant()`) commits on its own, and the outer one does not see what it wrote, so a later reference to it fails as missing. Do the work in the same transaction; for a global record written from a workspace (a person's identity on invite), use `tx.unscoped(name)` at a reviewed call site.
- `$unionWith`, `$out` and `$merge` are not available. Use two queries.

## Not yet done (PR 9)

- Deploy stack (`infra/deploy/compose.yml`), encrypted `mongodump` backups, restore and the DR drill.
- A MongoDB role for the API that can only insert into `audit_events`.
