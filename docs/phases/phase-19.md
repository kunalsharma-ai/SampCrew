# Phase 19 report: plans decide every feature

Kunal asked (8 November 2026) that every feature of SampCrew be controlled by the Super Admin, with what a workspace may use decided by the subscription its admin buys. Before this phase the four plans were fixed in code, a few modules (email signatures, onboarding checklists) were open to every plan, and some catalogue keys (audit export, multiple legal entities) were not enforced.

## Working end to end

Everything below runs against the real API and PostgreSQL (migration `0027_plan_builder.sql`). API tests: `apps/api/test/plan-builder.spec.ts` (9) and `apps/api/test/plan-coverage.spec.ts` (4). Browser flow: `e2e/plans-flow.cjs` (`pnpm e2e:plans`, its own CI step on a fresh database).

### Super Admin Console, Plans & pricing (`/plans`)
- **Modules & limits** per plan: a switch for each of the 30 modules, grouped by area, and the four limits (employees, legal entities, AI credits, storage; -1 is unlimited). Core HR is always on. Saving says what was added and removed and how many workspaces it applies to; removing a module from a plan with workspaces asks first.
- **New plan**: from a copy of any plan (modules, limits and prices) or from the foundation only (Core HR, every limit 0). New plans are hidden until made visible.
- **Details**: name, tagline, minimum seats, display order, quote-only, visible to workspace admins.
- **Archive / restore**: an archived plan is not sold; workspaces on it keep it. Open requests for it are declined. A plan nobody was ever on can be deleted; the four launch plans cannot.
- **Plan requests**: requests from workspace admins for quote-only plans, approved (the workspace moves to the plan with the seats asked for) or declined with a reason. The admin who asked gets a notification and an email.
- Every change goes to the platform audit log, and a change to a plan's contents is also written to each affected workspace's own audit trail (`subscription.plan_contents_changed`).
- Creating a workspace offers every plan that is on sale, not a fixed list of four.
- Capability `plans:manage` (Super admin, Billing ops) to change plans; `billing:read` to see them.

### Enforcement
- A plan change applies on the workspace's next request: entitlements are read from `plan_features` per request. Workspace switches, per-app switches and per-person blocks from Features & permissions still apply on top.
- New modules with their own switch: **Onboarding checklists** (`onboarding`) and **Email signatures** (`email_signatures`, including the Windows sync, which stops when the plan loses it). Every existing plan got both, so no workspace lost anything.
- **Talent split** into **Goals & reviews** (`performance`), **Learning** (`learning`) and **Engagement** (`engagement`: recognition, values, surveys), so plans can include one without the others. Stored switches, member blocks and app switches that said `talent` were rewritten.
- **Audit log export** (`audit_export`): new `GET /audit-events/export.csv` with the on-screen filters (up to 50,000 events, the export itself is audited) and a Download CSV button on Settings > Audit trail.
- **Multiple legal entities** (`multi_entity`): a second legal entity needs it, as well as room under the entity limit. A plan change that would leave several entities without it is refused.
- **Attendance machines and kiosks** refuse punches and QR codes when the plan has no advanced attendance (logged on the device).
- `plan-coverage.spec.ts` fails if a new workspace route has neither a plan module nor a written reason it is foundation, if a public route is not listed with the check its service makes, or if a sellable module gates nothing.
- The deploy-time catalogue sync no longer overwrites plans: a plan changed in the Console keeps its contents and only receives modules that are new to the catalogue.

### Web Portal
- Navigation, quick actions, home cards and profile tabs follow the new modules (Goals, Reviews, Learning, Recognition, Surveys, Onboarding, Email signatures, My tasks).
- Plan & billing has a **Compare plans** table (every module and limit for every plan on sale), a **Request this plan** dialog for quote-only plans, the open request with Withdraw, the answer when declined, a notice when the workspace's plan is no longer sold, and a notice when SAMPLEDGE switched off a module the plan includes.
- Opening a module that is not in the plan shows "Not included in your plan" (HTTP 402 from the API).

### Mobile app
- No new screens. Its tabs and home cards already follow `/me` features (attendance, leave, helpdesk, announcements, payslips), and the API refuses anything outside the plan.

## Not yet working
- No payment collection: switching to a self-serve plan applies at once and SAMPLEDGE finance invoices it, as before. No card or UPI provider is connected.
- `global_payroll` and `enterprise_support` are commercial entitlements with no in-app function yet; the Console labels them that way.
- The mobile app has no Plan & billing screen; admins buy plans in the Web Portal.
- The e2e flow ran on a local build (Chromium, fresh database), not on real phones.
