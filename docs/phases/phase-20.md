# Phase 20 report: MongoDB migration, part 1 (foundation)

Kunal asked (9 November 2026) to use Express.js and MongoDB in place of Fastify and PostgreSQL. The API has never used Fastify: it is NestJS 11 running on Express (`@nestjs/platform-express`), so the HTTP layer stays as it is. The change is PostgreSQL to MongoDB. Kunal chose to keep NestJS on Express and move the data layer module by module, in about nine PRs. This is the first PR.

PostgreSQL still runs every feature after this PR. Nothing a user sees changes yet. MongoDB is optional (`MONGODB_URL`), and it only counts towards readiness once it is set.

## The plan

| PR | Scope |
| --- | --- |
| 1 (this one) | Foundation: MongoDB client, workspace-scoped data access, transactions, migrations, audit chain, tests, CI, local setup |
| 2 | Identity and access: tenancy, auth, sessions, MFA, SSO, SCIM, members, roles, plans and entitlements, billing |
| 3 | Core HR: employees, organization, documents, onboarding, setup, approvals, notifications |
| 4 | Time: attendance, shifts, devices, leave |
| 5 | Recruitment and staffing: jobs, candidates, interviews, bids, rate cards |
| 6 | Payroll |
| 7 | Talent and engagement: reviews, goals, learning, surveys, recognition, helpdesk, announcements, signatures |
| 8 | Intelligence and integrations: AI, IQ, automation, insights, universe, integrations, privacy, platform admin |
| 9 | Cut-over: seed and demo data, Docker and backups, DR drill, docs, remove `pg`, full e2e and load test |

Modules join each other's tables almost everywhere, so PRs 2 to 8 stack on one integration branch and `main` keeps PostgreSQL until PR 9. This PR only adds code and can merge to `main` on its own.

## Working end to end

Everything below runs against a real MongoDB 8.0 replica set. The tests are in `apps/api/test/mongo` (22 tests, `pnpm test:mongo`), and CI runs them as their own step.

### Workspace isolation without row-level security (`apps/api/src/platform/database/mongo.service.ts`, `mongo-scope.ts`)
- `MongoService.tenant()`, `user()` and `platform()` match the three `DatabaseService` transaction kinds.
- In a workspace transaction, every filter is narrowed to that workspace and every insert is stamped with its `tenant_id`. Updates cannot change `tenant_id`, through operators or update pipelines. A filter or document that names another workspace throws `ScopeViolationError` instead of quietly returning nothing.
- In aggregations, `$lookup`, `$graphLookup` and `$facet` get the same workspace filter on whatever they read. `$out`, `$merge`, `$unionWith`, `$documents` and every stage not on the allow-list are refused.
- Each collection is registered with a scope in `packages/db/src/mongo/collections.ts`: `tenant`, `shared` (read-only reference data) or `platform` (never reachable from a workspace). An unregistered collection cannot be used at all.
- `user()` reads only the signed-in user's own documents (for example their memberships, before a workspace is chosen), and only reads.
- A test fails if any file outside `src/platform/database` imports the MongoDB driver, which is how every query used to have to go through `DatabaseService`.

### Transactions and locking
- Each transaction is one multi-document MongoDB transaction (snapshot reads, majority commit). An error anywhere, deferred work included, rolls back everything.
- `defer()` replaces `deferUntilCommit`: the work runs inside the transaction, last, in the order it was asked.
- Read-then-write updates on one document are serialised. MongoDB aborts the conflicting transaction and the driver runs it again. This replaces `select ... for update`, and the test runs 20 concurrent read-then-increment transactions that end at exactly 20.

### Tamper-evident audit trail (`packages/db/src/mongo/audit-chain.ts`)
- The same hash chain per workspace (plus one for platform events), with the same hashed fields as `audit_event_payload()` in PostgreSQL. The JSON is canonical, so key order cannot change a hash.
- Each chain has a head document. Concurrent appends conflict on it, so the chain stays linear without a lock. The test runs 25 concurrent transactions across two workspaces.
- `verifyAuditChain` finds the first edited event. A workspace can read its trail but never write it, and an audit event for another workspace is refused.

### Migrations (`packages/db/src/mongo/migrator.ts`)
- Numbered steps declare collections, `$jsonSchema` validators and indexes as data, plus an optional `up` for data changes. They run in order, each once.
- A lock document stops two deploys from running migrations together. A step edited after it was applied is refused, as with the SQL checksums.
- `0001_foundation` creates `audit_events` (validator and the four indexes from PostgreSQL) and `audit_heads`. Ids are UUID strings, so ids in URLs, API responses and tests stay the same.
- `pnpm db:migrate:mongo` applies them to `MONGODB_URL`.

### Local setup and CI
- `infra/docker/docker-compose.yml` starts a single-node replica set (`mongo:8.0`, initiated by its health check).
- `.env.example` documents `MONGODB_URL` and `MONGODB_POOL_MAX` (commented out until modules use them).
- CI starts a MongoDB replica set in the test job and runs `pnpm test:mongo` after `pnpm test`.
- `/health/ready` also checks MongoDB once `MONGODB_URL` is set.

## Not yet working
- No feature reads or writes MongoDB yet. That starts in PR 2.
- MongoDB server roles are not set up yet. PostgreSQL gave the API login no table privileges and kept `audit_events` append-only at the database level. With MongoDB that protection is in our code. A database role that can only insert into `audit_events` comes with PR 9's deploy work.
- Production hosting (MongoDB Atlas or a self-hosted replica set in `infra/deploy`) is still Kunal's choice. Backups (`mongodump`), restore and the DR drill move in PR 9.
- `$unionWith` cannot be used: MongoDB does not allow it inside transactions. Reports that need it will run two queries instead.

---

# Phase 20, part 2: the whole move

The plan above had parts 2 to 9 as separate pull requests stacked on one branch. Because the modules join each
other's data almost everywhere, they were done on one branch and land together in one pull request. After it,
PostgreSQL is gone: there is no `pg` dependency, no SQL migration and no `DATABASE_*` setting.

## What changed

- **Every module** reads and writes MongoDB through `MongoService` (`tenant()`, `user()`, `platform()`), and the
  PostgreSQL `DatabaseService` is deleted.
- **The PostgreSQL rules are kept.** `packages/db/src/mongo/schema.generated.ts` was generated once from migrations
  0001 to 0027 and is now the schema. From it the data layer enforces, on every write: types and defaults, enums,
  NOT NULL, unique keys (including case-insensitive and partial ones), foreign keys with their delete rules,
  column grants for workspace transactions, the triggers (as row guards), and the CHECK constraints. All 373 CHECKs
  are compiled into the collection validators (`checks.ts`), so the server refuses a bad document whoever writes it,
  with SQL's rule that only a false CHECK fails.
- **Reads look like before**: `id` for `_id`, decimals as strings, dates as `YYYY-MM-DD`, and every declared column
  present (null when not set), so API responses did not change.
- **Seed and demo data** (`packages/db/scripts`): `pnpm db:migrate`, `db:seed` and `db:reset` work on MongoDB; the
  Northwind demo workspace is written in one transaction through the same data rules as the API.
- **Production stack** (`infra/deploy`): a one-node MongoDB 8.0 replica set with authentication and a replica set
  key, an API user (`crew_api`, read and write on the SampCrew database only) created by the migration job, gzip
  `mongodump` backups (encrypted as before), a restore script that refuses a non-empty database and checks every
  validator and audit chain after restoring, and the backup and restore drill (`dr-drill`) rewritten for MongoDB. For
  MongoDB Atlas, set `MONGODB_URL` and `MONGODB_ADMIN_URL` and start without the bundled server.
- **Configuration**: `MONGODB_URL` is required. In staging and production the API refuses a URL without a database
  user and a real password (unless it signs in with X.509, AWS or OIDC).
- **CI** starts a MongoDB replica set (`infra/ci/start-mongo.sh`) for the tests, the end-to-end flows, the drill and
  the ClamAV job; the production-stack smoke test builds the MongoDB stack.

## Tests

- 447 API tests (38 files) and 42 data-layer tests pass on MongoDB.
- Tests that checked PostgreSQL itself (roles, RLS, triggers) now check the same rule in the data layer: a workspace
  transaction cannot update or delete what PostgreSQL's grants refused, cross-workspace references are refused, and
  frozen records stay frozen.
- One test changed meaning: two recomputes of the same attendance day racing each other. PostgreSQL made the second
  wait for the first; MongoDB aborts one and runs it again. The test now checks that both finish and exactly one
  correct day is stored.

## Throughput under load

The workflow load test (`e2e/load-workflows.cjs`: 100 hires, salaries, a payroll run, then punches, leave and
helpdesk from 12 users at once) first failed on MongoDB with no errors but slow writes: leave requests at a p95 of
15 s and hires at 3.3 s. Two documents every write in a workspace touched, the audit chain head and the employee
number series, made concurrent transactions abort and run again. Audit events are now linked into the chain right
after the commit, and employee numbers are reserved in their own short transaction. The same test now passes:
leave 0.44 s, hires 0.81 s, every other step under 0.7 s at p95, no errors.

## Not done yet

- A custom MongoDB role that lets the API only insert into `audit_events`. Today the data layer refuses any change,
  and the hash chain shows a change made outside SampCrew.
- MongoDB Atlas or self-hosted for production is still Kunal's choice; both are supported.
