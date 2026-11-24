# Simple leave, Workspace Permissions and central Settings (2026-11-23)

Migration: `0160_simple_leave_permissions`. Test: `apps/api/test/simple-leave.spec.ts` (the 18 acceptance scenarios).

## Why leave numbers appeared by themselves

Three things credited days with nobody typing them:

1. `provision.ts` created Permanent, Casual and Sick Leave (18, 8 and 8 days) for every new workspace and allocated
   them to everyone.
2. The hourly job `runAccruals` posted accrual lines, prorated by joining date. That is where values like "1 CL",
   "2 CL" and "5 SL" came from.
3. Hiring someone ran the accruals at once.

All three are removed. So are allocations, the template and starter endpoints, and year-end carry forward and lapse.

## Leave now

- A leave type has a name, a description, an optional code (made from the name if left empty), a visibility and a
  status. The visibility is one of HR Workspace Only, Employee Workspace Only or Both Workspaces. A type shows up
  wherever it is visible. Super Workspace types are reviewable by every HR Workspace that has Leave. An HR Workspace's
  own types reach only its own people.
- The quantity is only what an administrator types on Leave management > Quantities (`PUT /leave/quantities`). It is
  per employee, per type and per year, stored as an `adjustment` ledger line for the difference.
  - Opening balances, manual adjustments and reward payouts are adjustments too, so they still count.
  - With no quantity, the employee sees Not Assigned and can still apply.
  - Going over the quantity gives a warning that HR sees, and does not block the application.
  - Nobody can assign days to themselves.
- An HR Workspace creates, edits, switches off and changes the visibility of its own types only, and only when the
  Super Workspace allows it in Workspace Permissions. These permissions are `leavetypes:create`, `leavetypes:edit`,
  `leavetypes:disable` and `leavetypes:visibility`, and all four are off by default.
  - An HR Workspace can never change a Super Workspace type. A refusal is audited as `leave_type.change_denied`.
  - An HR Workspace cannot make a type visible to the Employee Workspace while Leave is switched off for the Employee
    Workspace level.
- Approve and reject are separate permissions (`leave:approve` and `leave:reject`). Statuses: Pending, Approved,
  Rejected, Cancelled. Each application has a reference (LV-XXXXXX) and an audit trail.
- History stays as it was. Old accrual, carry forward and lapse lines remain in the ledger and count for nothing. Old
  allocations remain as history.

## Workspace Permissions

- The page is Settings > Workspace Permissions (`/settings/workspace-permissions`, API `/workspace-permissions`).
- Switches are kept per HR Workspace (or `central`) and once for all Employee Workspaces, in `level_permissions`.
- The categories are Employee, Leave, Attendance, Department, Reports, Workspace and Settings. Every other module of
  the level gets its own category automatically.
- Switches only take permissions away. A level never gets more than its access gives, and a module switched off above
  has no effect.
- Enforcement happens in the API, in two places:
  - `applyWorkspacePermissions` removes the switched-off permissions from the request's grants.
  - Route switches (for example "Create departments") refuse the call in the auth guard. Those refusals are audited as
    `workspace_permissions`.
- Templates:
  - Default HR and Default Employee can be edited, and Reset template puts them back to the SampCrew defaults.
  - All permitted switches everything on.
  - Custom keeps the switches as they are.
  - A new HR Workspace starts from the template chosen on the create form.
- The old per-HR-Workspace "Employee data permissions" switches (`hr_workspaces.permissions_off`) now read and write
  the same store. Migration 0160 copies them over and keeps the old field for rollback.

## Settings and dashboards

- `/settings` is one hub with every settings page, in categories, with search. It is built from the menu rules, so the
  hub and the menu always agree.
- The Super Workspace home has a Leave overview with real counts, shortcuts to create a leave type, assign quantities
  and open Workspace Permissions. HR quick actions and the HR leave summary gained the same shortcuts.
- The employee home, the leave page, the profile and the mobile app show Not Assigned instead of a number.

## Limits

- Quantities are entered one cell at a time. There is no bulk import of quantities yet: the data import still accepts
  opening balances.
- The Console's own screens were left to the Console redesign thread.
