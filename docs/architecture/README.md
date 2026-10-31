# CREW by SAMPLEDGE — Architecture Pack (Phase 0)

> One Intelligent Platform. Your Entire Workforce.

This folder is the Phase 0 deliverable from the master brief, section 28 ("First Execution Instructions"). Each file answers one of the thirteen required items and is kept in the repository so it versions together with the code it describes.

| # | Item | File |
|---|------|------|
| 1 | Recommended technology stack and reasons | [01-technology-stack.md](01-technology-stack.md) |
| 2 | Complete application architecture | [02-application-architecture.md](02-application-architecture.md) |
| 3 | Database entity relationship design | [03-database-design.md](03-database-design.md) |
| 4 | Module dependency architecture | [04-module-dependencies.md](04-module-dependencies.md) |
| 5 | User role and permission matrix | [05-roles-and-permissions.md](05-roles-and-permissions.md) |
| 6 | Web application architecture | [06-web-architecture.md](06-web-architecture.md) |
| 7 | Android and iOS architecture | [07-mobile-architecture.md](07-mobile-architecture.md) |
| 8 | AI and automation architecture | [08-ai-and-automation.md](08-ai-and-automation.md) |
| 9 | Attendance hardware integration strategy | [09-attendance-hardware.md](09-attendance-hardware.md) |
| 10 | Global payroll strategy | [10-global-payroll.md](10-global-payroll.md) |
| 11 | UI/UX design system | [11-design-system.md](11-design-system.md) |
| 12 | Project folder structure | [12-folder-structure.md](12-folder-structure.md) |
| 13 | Phase-wise development and testing roadmap | [13-roadmap.md](13-roadmap.md) |

Supporting documents:

- [security.md](../security.md): threat model, controls, privacy design.
- [innovation-layer.md](innovation-layer.md): the 20 next-generation capabilities, each documented with the ten required differentiation points.

## Guiding decisions (short version)

1. **Modular monolith first.** One NestJS API process with strict domain modules, one PostgreSQL database, background workers from the same codebase. Modules talk through published service interfaces and domain events, never through each other's tables. This keeps operations cheap for SMB pricing while leaving clean seams to split services out later.
2. **Tenant isolation is enforced by the database, not only by code.** Every tenant-owned table carries `tenant_id` and has a PostgreSQL Row-Level Security policy. The API connects as a role that cannot bypass RLS. A forgotten `WHERE tenant_id = ...` returns nothing instead of leaking data.
3. **Three experiences, one backend.** The tenant Web Portal (`apps/web`), the SAMPLEDGE Super Admin Console (`apps/console`) and the Employee/Manager mobile app (`apps/mobile`, Phase 7) all speak to the same versioned REST API and share one contracts package (`packages/contracts`) for request/response schemas and the permission catalogue.
4. **Humans decide, AI assists.** Every AI action is logged, explainable and permission-scoped. Consequential employment and payroll actions always require an authorised human approval.
5. **No fake integrations.** Every external provider sits behind an adapter interface with a clearly labelled simulator. The UI shows a connection as live only when real credentials have been verified.
