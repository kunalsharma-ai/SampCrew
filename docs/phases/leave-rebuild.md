# Leave management rebuild

Kunal asked (21 November 2026) for leave management rebuilt across the four levels: the Console switches the module
on or off, the Super Workspace owns leave types and their policies, allocation is separate from creation, HR
Workspaces allocate within what they were given and approve, and every employee sees their own types, rules and
the status of each application at every authority. This is the leave part of the specification only; attendance,
data import, learning, dashboards, the redesign and documents are separate pieces of work.

Migration: `0040_leave_rebuild` (the leave range is 0040-0049). New permission: `leave:allocate` (Super Workspace and
HR Workspaces). `leave:configure` is now Super Workspace only: it is no longer part of the HR Workspace level.

## Working end to end, and not yet

### Working end to end
Each item runs against the real API and MongoDB. `apps/api/test/leave-rebuild.spec.ts` walks the 22 acceptance
scenarios of section 16 of the specification, plus documents and escalation. `e2e/leave-flow.cjs` drives the Web
Portal, and `e2e/mobile-flow.cjs` the mobile app's web build at phone size.

- **Console**: the per-workspace module switch turns leave off and on. Records stay while it is off.
- **Leave types** (Leave management, Leave types tab, Super Workspace): create, edit, activate or deactivate (with a
  reason), and remove a type nobody has used. Each type carries:
  - its basics: name, code, category, paid or unpaid, half days, calendar or working days, colour and an effective date;
  - its eligibility: employment types, departments, designations, locations, legal entities, groups, named people and gender;
  - its policy: entitlement, accrual (yearly, quarterly, monthly, granted or none), the shortest and longest
    application, consecutive days, notice, carry forward and expiry, probation, negative balance, and documents;
  - its approval rules: HR Workspace, Super Workspace, both (at the same time or one after the other), or the
    employee's choice between them, with an optional manager step first, Super Workspace review over a number of
    days, and escalation.

  Every change is a new version, with who changed it, when and what. Applications keep the version they were
  made under.
- **Defaults**: new workspaces start with PL (Permanent Leave), CL (Casual Leave) and SL (Sick Leave), created as
  ordinary records and allocated to everyone. A Super Workspace can add them again ("Add PL, CL and SL"), add more
  from templates, or create its own.
- **Allocation** (Allocation tab):
  - The Super Workspace gives a type to people (everyone eligible, or any mix of employment types, departments,
    designations, locations, legal entities, groups and named people), or makes it available to an HR Workspace or
    the company HR team.
  - An HR Workspace allocates only the types it was given, only to its own people and only inside each type's
    eligibility.
  - A live preview names who an allocation reaches. The most specific allocation wins.
  - Withdrawing an allocation stops new credits; the history stays.
- **Applying** (Leave page, web and phone):
  - The employee sees each type they hold with its rules, where applications go, who manages it and who created
    and allocated it.
  - The apply form previews the days and the balance afterwards, offers the route when the type lets the employee
    choose, says who it goes to, and takes supporting documents (up to 5, 10 MB each) when the policy asks.
  - The server checks every rule again: eligibility, balance, notice, length, probation, overlap, documents and the
    route.
- **Approvals**:
  - Each authority sees only what was sent to it: the Approvals tab of Leave management, the Approvals page, and
    the phone.
  - An application sent to both is approved only when both approve. One rejection ends it and withdraws the other step.
  - The application page (`/leave/requests/[id]`) shows each authority's decision with remarks and the documents.
  - Downloads of documents are recorded in the audit log.
  - Changing and cancelling work as before, and a change goes through the same route.
- **Dashboards and reports**:
  - The Dashboard tab shows type counts, applications waiting for you, people on leave today, decisions this year,
    use by type, the HR Workspace breakdown and upcoming leave, filtered by year and HR Workspace.
  - The Reports tab shows use by type, by department and by employee.
  - The History tab shows every creation, change, deactivation and allocation with who did it.
- **Holidays and leave rules** (Settings): holiday calendars and the same-day leave rule, for the Super Workspace and
  HR Workspaces. Year-end and accrual runs stay with the Super Workspace.
- **Existing workspaces** (migration 0040):
  - Each type takes the policy of its widest policy.
  - The leave approval chain becomes each type's approval rules. A manager step stays as "manager first", followed
    by HR (or the Super Workspace when the chain ended with the owner).
  - Policies for an entity, department or other scope become allocations.
  - Balances, the ledger and all applications are untouched.
  - The old leave approval chain on Approval settings is now read-only and points to the leave types.

### Not yet
- Escalation runs with the daily HR jobs (and on demand from the API). There is no separate schedule per workspace.
- Reports are on screen. There is no Excel export for them yet.
- The mobile app shows each authority's status and lets the employee choose the route. It does not yet attach
  documents or show the type's rules. Those are on the web.

## API changes (for the mobile app and integrations)
- Removed: `GET /leave/policies` and the policy routes (rules live on the type), and `POST /leave/types/defaults`
  (now `POST /leave/types/starter`).
- New:
  - `GET /leave/mine`, `GET /leave/options`
  - `GET/POST /leave/allocations`, `POST /leave/allocations/preview`, `POST /leave/allocations/:id/revoke`
  - `GET /leave/dashboard`, `GET /leave/reports`, `GET /leave/history`
  - `POST /leave/documents`, `POST /leave/requests/:id/documents/:fileId/link`
  - `POST /leave/types/:id/status`, `POST /leave/escalations/run`
  - `GET /leave/requests?scope=review`
- Applications take `approvalRoute` (`hr`, `super` or `both`) and `documentIds`. Request views add `reference`,
  `approvalRoute`, `approvalRouteLabel`, `authorities`, `documents` and `policySnapshot`.
