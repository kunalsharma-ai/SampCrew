# 1. Recommended Technology Stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** everywhere (web, API, workers, mobile, contracts) | One language means shared validation schemas, shared permission catalogue and one hiring profile. Strict mode on. |
| Monorepo | **pnpm workspaces** | Fast, disk-efficient, strict dependency isolation. Turborepo can be layered on when build times demand it. |
| Web frontend | **Next.js 15 (App Router) + React 19** | Server components for fast first paint on data-heavy dashboards, route-level code splitting, mature ecosystem, works behind any CDN. |
| Styling | **Tailwind CSS 4** + CSS-variable design tokens | Tokens live in one place (`packages/ui`) and drive light/dark themes and per-tenant brand colours without rebuilds. |
| Component library | **`@crew/ui`** (own package) on top of **Radix UI primitives** | Radix gives accessible behaviour (focus, ARIA, keyboard) so we own the visual identity without re-solving accessibility. |
| Charts | **Recharts** now, **Apache ECharts** for heavy heatmaps/large series | Recharts is React-native and themeable; ECharts handles 100k-point attendance heatmaps. |
| Backend | **NestJS 11** | Opinionated modules, dependency injection, guards/interceptors map cleanly onto tenant context, RBAC/ABAC, entitlements and auditing. |
| API style | **REST, versioned `/api/v1`**, OpenAPI 3.1 generated from code; **WebSockets** (Socket.IO gateway) for live dashboards and device status | REST is easiest for partners, mobile and integrators; OpenAPI gives SDK generation for free. |
| Validation | **zod** schemas in `@crew/contracts`, used by API pipes, web forms and mobile | A field rule is written once and enforced identically on every client and the server. |
| Database | **PostgreSQL 16** | Row-Level Security for tenant isolation, JSONB for configurable fields, strong `numeric` type for payroll, partitioning for attendance events, mature HA options (RDS/Aurora/Cloud SQL/Azure Flexible Server). |
| Data access / migrations | **SQL-first**: numbered, checksummed SQL migrations (`packages/db`) and parameterised queries through `node-postgres` inside tenant-scoped transactions | RLS policies, triggers, partitions and exclusion constraints are first-class in plain SQL, and every query is visible in review. A typed query builder (Kysely) can be layered on per module later without changing the transaction model. |
| Cache, locks, rate limits | **Redis 7** (Valkey compatible) | Session revocation lists, rate-limit buckets, idempotency keys, BullMQ queues. |
| Jobs and queues | **BullMQ** on Redis now; outbox table + **NATS JetStream or AWS SQS/SNS** when volume demands | Transactional outbox guarantees events are published only when the DB commit succeeds. |
| Object storage | **S3-compatible** (AWS S3, Cloudflare R2, MinIO locally) | Documents, resumes, payslips. Per-tenant prefixes, server-side encryption with KMS keys, signed URLs only. |
| Search | **PostgreSQL full-text + pg_trgm** now; **OpenSearch** for candidate search at scale; **pgvector** for semantic search | Avoids running a search cluster for small tenants while keeping a clear upgrade path. |
| Analytics warehouse | **ClickHouse** (or BigQuery/Snowflake per customer) fed by CDC from the outbox | Keeps heavy analytics off the OLTP database. |
| AI | Provider-agnostic **AI Gateway** module; adapters for Anthropic Claude, OpenAI, Azure OpenAI, Google, self-hosted models | Tenants can pick providers, bring keys, or disable AI entirely; usage and cost are metered per tenant. |
| Mobile | **React Native with Expo (bare workflow when needed)** | Shares TypeScript contracts, API client and business rules with web; Expo modules cover biometrics, secure storage, camera, location, push. See [07](07-mobile-architecture.md) for the Flutter comparison. |
| Device agent | **Go** single-binary sync agent | Runs on a Windows/Linux box inside a factory LAN, talks vendor SDKs/TCP protocols, buffers offline, pushes signed batches to the API. Go cross-compiles easily and has a tiny footprint. |
| Auth | Own auth service in the API: **argon2id** passwords, **TOTP MFA**, short-lived **JWT** access tokens + rotating **refresh tokens** (hashed, revocable), **OIDC/SAML SSO** in Phase 10 | Keeps tenant-aware identity in our control; enterprise SSO plugs into the same session model. |
| Testing | **Vitest** (unit + integration against a real PostgreSQL), **Playwright** (web E2E), **Detox/Maestro** (mobile E2E), **k6** (load) | Integration tests run against real RLS policies, not mocks. |
| Containers / IaC | **Docker**, **docker compose** for local, **Terraform** for cloud, **Kubernetes (EKS/GKE/AKS)** or ECS for runtime | Portable across clouds and customer-hosted enterprise deployments. |
| CI/CD | **GitHub Actions** | Lint, type-check, test with a Postgres service, build images, deploy by environment with manual promotion to production. |
| Observability | **OpenTelemetry** traces/metrics, **pino** structured logs, **Sentry** error tracking, Grafana/Prometheus dashboards | Every log line carries `tenantId`, `userId`, `requestId`. |
| Secrets | Environment variables locally; **AWS Secrets Manager / GCP Secret Manager / Vault** in deployed environments | Nothing secret is ever committed; `.env.example` documents every variable. |

## Alternatives considered

- **Microservices from day one**: rejected. It multiplies operational cost before product-market fit. Domain modules with event boundaries give the same future flexibility.
- **Prisma / Drizzle ORMs**: good DX, but RLS with per-transaction `SET LOCAL ROLE` and session variables, partitioned tables and triggers are clearer in plain SQL. Phase 1 started SQL-first; revisit if query volume per module makes a builder worthwhile.
- **Database-per-tenant**: offered later as an Enterprise "dedicated cell" deployment. The default shared-schema + RLS model is far cheaper to run for thousands of SMB tenants. The code does not care which one it runs on.
- **GraphQL**: attractive for dashboards, but REST + OpenAPI is simpler for third-party integrators, webhook consumers and mobile caching. A read-only GraphQL layer can be added for analytics later.
