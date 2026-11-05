# 5. User Role and Permission Matrix

> Generated from `packages/contracts/src/permissions.ts` and `roles.ts` by `pnpm docs:permissions`. Do not edit by hand.

## 5.1 Model

CREW combines **RBAC** (roles bundle permissions) with **ABAC** (each grant carries a scope, assignments can carry constraints, and environmental conditions such as MFA apply):

- **Permission**: `resource:action`, for example `leave:approve`.
- **Scope** (which records the grant covers):
  - `O` own: records about the member themself.
  - `T` team: the member and everyone who reports to them, directly or indirectly.
  - `D` department: the member's department and all of its sub-departments.
  - `E` entity: the member's legal entity.
  - `A` all: the whole tenant.
- **Assignment constraints**: a role assignment can be narrowed to listed legal entities, departments or locations (for example, "HR Manager for India entity only").
- **Environmental conditions**: permissions marked MFA require a session that completed multi-factor authentication. Sensitive permissions are additionally audited on every read.
- **Custom roles**: tenants on plans with `custom_roles` can compose their own roles from the same catalogue. A member's effective permission is the widest scope across all their roles.
- **Tenant isolation is not a permission.** No role in a tenant can see another tenant; that is enforced by PostgreSQL Row-Level Security underneath every permission check.

## 5.2 Tenant roles × permissions

| Permission | Phase | MFA | Workspace Owner | Organization Admin | HR Admin | HR Manager | Recruiter | Hiring Manager | Payroll Admin | Finance Manager | Attendance Admin | Department Manager | Employee | Auditor |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Administration** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `tenant:read` View workspace settings | 1 |  | A | A | A | · | · | · | · | · | · | · | · | A |
| `tenant:manage` Change workspace settings (name, locale, timezone, branding) | 1 | yes | A | A | · | · | · | · | · | · | · | · | · | · |
| **Organization** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `org:read` View legal entities, business units, locations and departments | 1 |  | A | A | A | A | A | A | A | A | A | A | · | A |
| `org:manage` Create and change legal entities, business units, locations and departments | 1 |  | A | A | A | · | · | · | · | · | · | · | · | · |
| **Administration** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `users:read` View workspace members | 1 |  | A | A | A | E | A | O | A | O | A | T | O | A |
| `users:invite` Invite people to the workspace | 1 |  | A | A | A | · | · | · | · | · | · | · | · | · |
| `users:manage` Change member placement, suspend or reactivate members | 1 |  | A | A | A | E | · | · | · | · | · | · | · | · |
| `roles:read` View roles and role assignments | 1 |  | A | A | A | · | · | · | · | · | · | · | · | A |
| `roles:manage` Create custom roles and assign roles to members | 1 | yes | A | A | · | · | · | · | · | · | · | · | · | · |
| `audit:read` View and verify the audit trail | 1 |  | A | A | · | · | · | · | · | · | · | · | · | A |
| **Billing** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `billing:read` View subscription, invoices and usage | 1 |  | A | A | · | · | · | · | · | A | · | · | · | A |
| `billing:manage` Change plan, seats, billing cycle and add-ons | 1 | yes | A | · | · | · | · | · | · | · | · | · | · | · |
| **People** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `employees:read` View employee profiles | 2 |  | A | A | A | E | O | O | A | O | A | T | O | · |
| `employees:create` Create employee records | 2 |  | A | · | A | E | · | · | · | · | · | · | · | · |
| `employees:update` Update employee records | 2 |  | A | · | A | E | O | O | O | O | O | O | O | · |
| `employees:sensitive:read` View bank, tax and national ID details | 2 | yes | A | · | A | O | O | O | A | O | O | O | O | · |
| `employees:lifecycle` Run confirmations, transfers, promotions and exits | 2 |  | A | · | A | E | · | · | · | · | · | · | · | · |
| **Documents** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `documents:read` View employee documents | 2 |  | A | · | A | E | O | O | O | O | O | T | O | · |
| `documents:manage` Upload, generate and send documents for signature | 2 |  | A | · | A | E | · | · | · | · | · | · | · | · |
| **Leave** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `leave:read` View leave balances and requests | 2 |  | A | · | A | E | O | O | A | O | O | T | O | · |
| `leave:request` Apply for leave | 2 |  | O | · | O | O | O | O | O | O | O | O | O | · |
| `leave:approve` Approve or reject leave | 2 |  | A | · | A | E | · | · | · | · | · | T | · | · |
| `leave:configure` Configure leave types, policies and holidays | 2 |  | A | · | A | · | · | · | · | · | · | · | · | · |
| **Attendance** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `attendance:read` View attendance records | 3 |  | A | · | A | E | O | O | A | O | A | T | O | · |
| `attendance:punch` Record own attendance | 3 |  | O | · | O | O | O | O | O | O | O | O | O | · |
| `attendance:correct` Request attendance corrections | 3 |  | A | · | A | O | O | O | O | O | A | O | O | · |
| `attendance:approve` Approve corrections and overtime | 3 |  | A | · | A | E | · | · | · | · | A | T | · | · |
| `attendance:configure` Configure attendance policies, geofences and locks | 3 |  | A | · | A | · | · | · | · | · | A | · | · | · |
| `devices:manage` Manage biometric devices and sync agents | 3 |  | A | · | A | · | · | · | · | · | A | · | · | · |
| **Scheduling** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `shifts:read` View shifts and rosters | 3 |  | A | · | A | E | O | O | O | O | A | T | O | · |
| `shifts:manage` Create rosters, assign and swap shifts | 3 |  | A | · | A | E | · | · | · | · | A | T | · | · |
| **Recruitment** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `requisitions:read` View job requisitions | 4 |  | A | · | A | E | A | D | · | A | · | T | · | · |
| `requisitions:create` Raise job requisitions | 4 |  | A | · | · | · | A | D | · | · | · | T | · | · |
| `requisitions:approve` Approve job requisitions and budgets | 4 |  | A | · | A | E | · | · | · | A | · | · | · | · |
| `candidates:read` View candidates and applications | 4 |  | A | · | A | · | A | D | · | · | · | · | · | · |
| `candidates:manage` Manage candidates, move pipeline stages, communicate | 4 |  | A | · | · | · | A | O | · | · | · | · | · | · |
| `interviews:feedback` Submit interview feedback and scorecards | 4 |  | O | · | O | O | O | O | O | O | O | O | O | · |
| `offers:manage` Draft and send offers | 4 |  | A | · | · | · | A | · | · | · | · | · | · | · |
| `offers:approve` Approve offers | 4 | yes | A | · | A | E | · | · | · | · | · | · | · | · |
| `recruitment:configure` Configure pipeline stages, scorecards and the career site | 4 |  | A | · | A | · | A | · | · | · | · | · | · | · |
| **Payroll** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `payroll:read` View payroll runs and reports | 5 | yes | A | · | · | · | · | · | A | A | · | · | · | · |
| `payroll:run` Prepare and compute payroll runs | 5 | yes | A | · | · | · | · | · | A | · | · | · | · | · |
| `payroll:approve` Approve and finalise payroll runs | 5 | yes | A | · | · | · | · | · | · | A | · | · | · | · |
| `payroll:configure` Configure salary components, structures and statutory settings | 5 | yes | A | · | · | · | · | · | A | · | · | · | · | · |
| `payslips:read` View payslips | 5 |  | A | · | O | O | O | O | A | O | O | O | O | · |
| **Expenses** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `expenses:submit` Submit expense claims | 5 |  | O | · | O | O | O | O | O | O | O | O | O | · |
| `expenses:approve` Approve expense claims | 5 |  | A | · | · | · | · | · | A | A | · | T | · | · |
| **Performance** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `performance:read` View goals and reviews | 6 |  | A | · | A | E | O | O | O | O | O | T | O | · |
| `performance:manage` Set goals for, write manager reviews of and request feedback on people in scope | 6 |  | A | · | A | E | · | · | · | · | · | T | · | · |
| `performance:configure` Run review cycles, calibrate and release ratings | 6 |  | A | · | A | · | · | · | · | · | · | · | · | · |
| **Learning** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `learning:read` View courses and learning assignments | 6 |  | A | · | A | E | O | O | O | O | O | T | O | · |
| `learning:manage` Assign courses and track completion for people in scope | 6 |  | A | · | A | E | · | · | · | · | · | T | · | · |
| `learning:configure` Manage the course catalogue and learning paths | 6 |  | A | · | A | · | · | · | · | · | · | · | · | · |
| **Engagement** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `engagement:manage` Run surveys, see anonymous results, manage company values and moderate recognition | 6 |  | A | · | A | · | · | · | · | · | · | · | · | · |
| `surveys:respond` Answer anonymous surveys | 6 |  | O | · | O | O | O | O | O | O | O | O | O | · |
| `recognition:give` Recognise colleagues on the recognition wall | 6 |  | O | · | O | O | O | O | O | O | O | O | O | · |
| **Helpdesk** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `helpdesk:use` Raise HR helpdesk cases and read help articles | 7 |  | O | · | O | O | O | O | O | O | O | O | O | · |
| `helpdesk:manage` Handle HR helpdesk cases for people in scope | 7 |  | A | · | A | E | · | · | · | · | · | · | · | · |
| `helpdesk:configure` Manage helpdesk categories, handlers, response targets and help articles | 7 |  | A | · | A | · | · | · | · | · | · | · | · | · |
| **Announcements** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `announcements:read` Read announcements addressed to you | 7 |  | O | · | O | O | O | O | O | O | O | O | O | · |
| `announcements:manage` Publish announcements and see who has read them | 7 |  | A | · | A | · | · | · | · | · | · | · | · | · |
| **Analytics** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `reports:read` View workforce analytics and reports | 8 |  | A | A | A | E | O | · | A | A | · | T | · | A |
| `insights:attrition` See attrition risk scores, and the factors behind them, for people in scope (never shown to managers by default) | 8 |  | A | · | A | · | · | · | · | · | · | · | · | · |
| **Automation** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `automation:manage` Build, test and activate workflows | 8 | yes | A | A | A | · | · | · | · | · | · | · | · | · |
| **AI** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `ai:use` Use CREW AI assistants (always limited to the user's own permissions) | 8 |  | O | · | O | O | O | O | O | O | O | O | O | · |
| `ai:configure` Configure AI providers, features and limits | 8 | yes | A | A | · | · | · | · | · | · | · | · | · | · |
| **Integrations** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `integrations:manage` Connect and disconnect integrations | 9 | yes | A | A | · | · | · | · | · | · | · | · | · | · |
| **Administration** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `security:manage` Set up single sign-on and user provisioning (SCIM) | 10 | yes | A | · | · | · | · | · | · | · | · | · | · | · |
| `privacy:manage` Handle privacy requests: export a person's data and erase it | 10 | yes | A | · | A | · | · | · | · | · | · | · | · | · |
| **Staffing bids** | | |  |  |  |  |  |  |  |  |  |  |  |  |
| `bids:read` View staffing bids, their pricing and margins, and clients | 11 |  | A | · | A | · | A | · | · | A | · | · | · | · |
| `bids:manage` Create and price staffing bids, manage clients and templates, send approved proposals | 11 |  | A | · | · | · | A | · | · | · | · | · | · | · |
| `bids:approve` Approve staffing bids and their margins before they go to the client | 11 |  | A | · | A | · | · | · | · | A | · | · | · | · |

Legend: O own, T team, D department, E legal entity, A all (tenant), · not granted.

## 5.3 Role descriptions

- **Workspace Owner** (`tenant_owner`): Owns the CREW workspace, its subscription and every setting. Cannot be removed while they are the last owner.
- **Organization Admin** (`org_admin`): Administers organisation structure, members, roles and settings. No payroll data by default.
- **HR Admin** (`hr_admin`): Runs day-to-day HR operations across the organisation.
- **HR Manager** (`hr_manager`): HR business partner for one legal entity: people, leave, attendance and talent within that entity.
- **Recruiter** (`recruiter`): Manages requisitions, candidates, interviews and offers.
- **Hiring Manager** (`hiring_manager`): Raises requisitions for their department and evaluates candidates.
- **Payroll Admin** (`payroll_admin`): Prepares and runs payroll; finalisation still needs an approver.
- **Finance Manager** (`finance_manager`): Approves payroll and expenses, views costs and billing.
- **Attendance Admin** (`attendance_admin`): Configures attendance policies, devices, shifts and corrections.
- **Department Manager** (`department_manager`): Manages their reporting team: approvals, schedules, performance.
- **Employee** (`employee`): Self-service for every member: profile, attendance, leave, payslips, expenses, learning, helpdesk.
- **Auditor** (`auditor`): Read-only access to configuration and the audit trail. No sensitive personal data.

## 5.4 Platform roles (SAMPLEDGE Super Admin Console)

Platform staff authenticate in a separate realm (`platform_admins` table, separate login, MFA mandatory). They have **no** access to tenant data by default. Viewing a tenant's data requires a time-boxed support access grant that the tenant owner approves, and every action is written to both the platform audit log and the tenant's own audit log.

| Capability | super_admin | support | billing_ops | viewer |
|---|---|---|---|---|
| `tenants:read` | ✓ | ✓ | ✓ | ✓ |
| `tenants:manage` | ✓ | · | · | · |
| `billing:read` | ✓ | · | ✓ | ✓ |
| `billing:manage` | ✓ | · | ✓ | · |
| `plans:manage` | ✓ | · | ✓ | · |
| `support:request` | ✓ | ✓ | · | · |
| `admins:manage` | ✓ | · | · | · |
| `audit:read` | ✓ | ✓ | · | · |
| `health:read` | ✓ | ✓ | · | ✓ |
