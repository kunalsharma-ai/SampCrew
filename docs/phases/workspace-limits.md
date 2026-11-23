# Plan-based workspace limits

Kunal asked (22 November 2026) for HR Workspace and Employee Workspace limits that SAMPLEDGE sets per subscription plan
in the Console, that every company inherits from its plan, that are checked on every creation in the API and the
database, and that grow at once when the plan is raised or the company upgrades.

## How it works

Console > Plans > Modules & limits -> plan limits `max_hr_workspaces`, `max_employee_workspaces` -> the company's
subscription (plan + limit add-ons + a per-company figure SAMPLEDGE agreed) -> checked on every creation.

- **HR Workspaces**: HR Workspaces that are not archived. The limit already existed on plans (phase 29); it now goes
  through the shared check and the database guard.
- **Employee Workspaces** (new): every sign-in account of the company that is not suspended (invited ones hold their
  place). Each person who signs in has their own Employee Workspace, whatever their level, so this cannot be bypassed
  by giving people a higher level. Employee records without a login are not counted (they count against
  "Employees included", `max_employees`, as before).
- Nothing is copied onto the company: limits are read from the plan on each request, so a Console edit or an upgrade
  applies straight away. Lowering a limit removes nothing; the company keeps what it has and cannot add more.
- Overage billing does not apply to these limits; they always stop at the limit.

## Where it is enforced

- `WorkspaceLimitsService.require` (apps/api/src/modules/workspace-limits): HR Workspace creation, invitations, logins
  made with a temporary password, unlocking a login, reactivating a suspended member, SCIM create and reactivate,
  and SSO just-in-time accounts. A refusal is 402 `workspace_limit_reached` with the message, and an audit event
  `workspace_limit.reached`.
- Database guard (packages/db/src/mongo/workspace-limits.ts, row guards `workspace_limit_hr` on `hr_workspaces`,
  `workspace_limit_employee` on `memberships`): any write that makes one more than allowed aborts, whatever code
  made it. It writes to the subscription document first, so concurrent creations conflict and are retried in turn.
- Plan changes: a downgrade the current HR Workspaces or logins do not fit is blocked with a message (as for
  employees and legal entities). A plan must allow at least 1 Employee Workspace.

## Screens

- Web, Super Workspace: HR Workspaces page shows "Workspace limits" (HR Workspaces 5 / 6, Employee Workspaces 8 / 10);
  at the limit New HR Workspace closes and an alert offers "Upgrade to <plan>" or a limit add-on. Logins & access shows
  Employee Workspaces and closes Invite people at the limit; Add employee then offers only "No login for now".
  Plan & billing lists both in Usage, shows them on every plan card, and `?limit=` marks plans and add-ons with more room.
- Console: each company's page has a "Workspace limits" table (used / maximum, plan, add-ons, agreed figure, state).
  Saving a plan's limits says which companies are now above a lowered limit.

## Data

Migration `0130_workspace_limits`: every plan gains `max_employee_workspaces` set to its `max_employees` figure (so no
company is blocked on day one), and plans made before HR Workspaces get `max_hr_workspaces` unlimited. Built-in
catalogue plans: Starter 2 / 100, Professional 10 / 1000, Business 50 / 5000, Enterprise unlimited (HR / Employee
Workspaces). SAMPLEDGE sets the real figures in the Console.

## Working end to end, and not yet

### Working end to end
- API tests `apps/api/test/workspace-limits.spec.ts` (12): inheritance and Used / Maximum, blocking at the limit, separate
  tracking, database refusal of direct writes, 4 concurrent creations with 1 place left (exactly 1 succeeds), raising and
  lowering plan limits, suspending and reactivating logins, upgrade and blocked downgrade, a limit add-on and a
  per-company figure, who may see the figures. The rest of the API suite (674 tests) passes.
- Browser flow `e2e/workspace-limits-flow.cjs` (`pnpm e2e:workspace-limits`, own CI step): Console sets the limits, the
  Super Workspace fills them, the API refuses a bypass, the upgrade option, Console raises the plan and the company gets
  the room at once. Screenshots in the project Library, crew-preview/workspace-limits/.

### Not yet
- The mobile app shows no workspace-limit figures (Super Workspace creation happens on the web).
- A per-company figure is set in Console > company > Adjust subscription (limits), like the other limits; it is
  tested through the API but not in the browser flow.
