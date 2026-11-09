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
