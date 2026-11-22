# 5. User Role and Permission Matrix

> Generated from `packages/contracts/src/permissions.ts` and `roles.ts` by `pnpm docs:permissions`. Do not edit by hand.

## 5.1 Model

SampCrew has four access levels: **Console Admin** (SAMPLEDGE, in the Console) > **Super Workspace** > **HR Workspace** > **Employee Workspace**. Each level gives only part of what the level above it has, and the API enforces it. Designations, departments and job titles never give access.

Within the company, access combines **RBAC** (the level bundles permissions) with **ABAC** (each grant carries a scope, the level assignment can carry limits, and environmental conditions such as MFA apply):

- **Permission**: `resource:action`, for example `leave:approve`.
- **Scope** (which records the grant covers):
  - `O` own: records about the member themself.
  - `T` team: the member and everyone who reports to them, directly or indirectly.
  - `D` department: the member's department and all of its sub-departments.
  - `E` entity: the member's legal entity.
  - `A` all: the whole tenant.
- **Level limits**: an HR Workspace assignment can be narrowed to named HR Workspaces, legal entities, departments or locations, and to chosen areas (modules) in full or view only. People moved from the old roles keep their exact previous permissions as kept grants.
- **Employee Workspace**: everyone holds it. Team permissions apply only to people with someone reporting to them.
- **Environmental conditions**: permissions marked MFA require a session that completed multi-factor authentication. Sensitive permissions are additionally audited on every read.
- **No custom roles**: the access levels replace custom roles. A member's effective permission is the widest scope across their levels, within their limits.
- **Tenant isolation is not a permission.** No role in a tenant can see another tenant; that is enforced by the data layer's workspace transactions underneath every permission check.

## 5.2 Access levels × permissions

| Permission | Phase | MFA | Super Workspace | HR Workspace | Employee Workspace |
|---|---|---|---|---|---|
| **Administration** | | |  |  |  |
| `tenant:read` View workspace settings | 1 |  | A | A | · |
| `tenant:manage` Change workspace settings (name, locale, timezone, branding) | 1 | yes | A | · | · |
| **Organization** | | |  |  |  |
| `org:read` View legal entities, business units, locations and departments | 1 |  | A | A | A |
| `hierarchy:read` See the HR Workspaces of the company, their modules, admins and people | 29 |  | A | A | · |
| `hierarchy:manage` Create, change, suspend and archive HR Workspaces and decide which modules each one gets (Super Workspace) | 29 |  | A | · | · |
| **People** | | |  |  |  |
| `employees:transfer` Move employees between HR Workspaces and the central group, keeping their history | 29 |  | A | · | · |
| `modules:assign` Choose which of the HR Workspace's modules each employee gets | 29 |  | A | A | · |
| **Organization** | | |  |  |  |
| `org:manage` Create and change legal entities, business units, locations and departments | 1 |  | A | A | · |
| **Administration** | | |  |  |  |
| `users:read` View workspace members | 1 |  | A | A | T |
| `users:invite` Invite people to the workspace | 1 |  | A | A | · |
| `users:manage` Change member placement, suspend or reactivate members | 1 |  | A | A | · |
| `roles:read` View roles and role assignments | 1 |  | A | A | · |
| `roles:manage` Create custom roles and assign roles to members | 1 | yes | A | · | · |
| `audit:read` View and verify the audit trail | 1 |  | A | A | · |
| **Billing** | | |  |  |  |
| `billing:read` View subscription, invoices and usage | 1 |  | A | A | · |
| `billing:manage` Change plan, seats, billing cycle and add-ons | 1 | yes | A | · | · |
| **People** | | |  |  |  |
| `employees:read` View employee profiles | 2 |  | A | A | T |
| `employees:create` Create employee records | 2 |  | A | A | · |
| `employees:update` Update employee records | 2 |  | A | A | O |
| `employees:sensitive:read` View bank, tax and national ID details | 2 | yes | A | A | O |
| `employees:lifecycle` Run confirmations, transfers, promotions and exits | 2 |  | A | A | · |
| **Documents** | | |  |  |  |
| `documents:read` View employee documents | 2 |  | A | A | T |
| `documents:manage` Upload, generate and send documents for signature | 2 |  | A | A | · |
| **Leave** | | |  |  |  |
| `leave:read` View leave balances and requests | 2 |  | A | A | T |
| `leave:request` Apply for leave | 2 |  | O | O | O |
| `leave:approve` Approve or reject leave | 2 |  | A | A | T |
| `leave:configure` Create and change leave types, their policies and approval rules, holidays, and make types available to HR Workspaces (Super Workspace) | 2 |  | A | · | · |
| `leave:allocate` Allocate leave types to employees (an HR Workspace only the types made available to it, for its own people) | 2 |  | A | A | · |
| **Attendance** | | |  |  |  |
| `attendance:read` View attendance records | 3 |  | A | A | T |
| `attendance:punch` Record own attendance | 3 |  | O | O | O |
| `attendance:correct` Request attendance corrections | 3 |  | A | A | O |
| `attendance:approve` Approve corrections and overtime | 3 |  | A | A | T |
| `attendance:configure` Configure attendance policies, geofences and locks | 3 |  | A | A | · |
| `devices:manage` Manage biometric devices and sync agents | 3 |  | A | A | · |
| **Scheduling** | | |  |  |  |
| `shifts:read` View shifts and rosters | 3 |  | A | A | T |
| `shifts:manage` Create rosters, assign and swap shifts | 3 |  | A | A | T |
| **Recruitment** | | |  |  |  |
| `requisitions:read` View job requisitions | 4 |  | A | A | T |
| `requisitions:create` Raise job requisitions | 4 |  | A | A | T |
| `requisitions:approve` Approve job requisitions and budgets | 4 |  | A | A | · |
| `candidates:read` View candidates and applications | 4 |  | A | A | · |
| `candidates:manage` Manage candidates, move pipeline stages, communicate | 4 |  | A | A | · |
| `interviews:feedback` Submit interview feedback and scorecards | 4 |  | O | O | O |
| `offers:manage` Draft and send offers | 4 |  | A | A | · |
| `offers:approve` Approve offers | 4 | yes | A | A | · |
| `recruitment:configure` Configure pipeline stages, scorecards and the career site | 4 |  | A | A | · |
| **Payroll** | | |  |  |  |
| `payroll:read` View payroll runs and reports | 5 | yes | A | A | · |
| `payroll:run` Prepare and compute payroll runs | 5 | yes | A | A | · |
| `payroll:approve` Approve and finalise payroll runs | 5 | yes | A | A | · |
| `payroll:configure` Configure salary components, structures and statutory settings | 5 | yes | A | A | · |
| `payslips:read` View payslips | 5 |  | A | A | O |
| **Expenses** | | |  |  |  |
| `expenses:submit` Submit expense claims | 5 |  | O | O | O |
| `expenses:approve` Approve expense claims | 5 |  | A | A | T |
| **Performance** | | |  |  |  |
| `performance:read` View goals and reviews | 6 |  | A | A | T |
| `performance:manage` Set goals for, write manager reviews of and request feedback on people in scope | 6 |  | A | A | T |
| `performance:configure` Run review cycles, calibrate and release ratings | 6 |  | A | A | · |
| **Learning** | | |  |  |  |
| `learning:read` View courses and learning assignments | 6 |  | A | A | T |
| `learning:manage` Assign courses and track completion for people in scope | 6 |  | A | A | T |
| `learning:configure` Manage the course catalogue and learning paths | 6 |  | A | A | · |
| **Engagement** | | |  |  |  |
| `engagement:manage` Run surveys, see anonymous results, manage company values and moderate recognition | 6 |  | A | A | · |
| `surveys:respond` Answer anonymous surveys | 6 |  | O | O | O |
| `recognition:give` Recognise colleagues on the recognition wall | 6 |  | O | O | O |
| **Helpdesk** | | |  |  |  |
| `helpdesk:use` Raise HR helpdesk cases and read help articles | 7 |  | O | O | O |
| `helpdesk:manage` Handle HR helpdesk cases for people in scope | 7 |  | A | A | · |
| `helpdesk:configure` Manage helpdesk categories, handlers, response targets and help articles | 7 |  | A | A | · |
| **Announcements** | | |  |  |  |
| `announcements:read` Read announcements addressed to you | 7 |  | O | O | O |
| `announcements:manage` Publish announcements and see who has read them | 7 |  | A | A | · |
| **Analytics** | | |  |  |  |
| `reports:read` View workforce analytics and reports | 8 |  | A | A | T |
| `insights:attrition` See attrition risk scores, and the factors behind them, for people in scope (never shown to managers by default) | 8 |  | A | A | · |
| **Automation** | | |  |  |  |
| `automation:manage` Build, test and activate workflows | 8 | yes | A | A | · |
| **AI** | | |  |  |  |
| `ai:use` Use SampCrew AI assistants (always limited to the user's own permissions) | 8 |  | O | O | O |
| `ai:configure` Configure AI providers, features and limits | 8 | yes | A | · | · |
| **Integrations** | | |  |  |  |
| `integrations:manage` Connect and disconnect integrations | 9 | yes | A | · | · |
| **Administration** | | |  |  |  |
| `security:manage` Set up single sign-on and user provisioning (SCIM) | 10 | yes | A | · | · |
| `privacy:manage` Handle privacy requests: export a person's data and erase it | 10 | yes | A | A | · |
| **Staffing bids** | | |  |  |  |
| `bids:read` View staffing bids, their pricing and margins, and clients | 11 |  | A | A | · |
| `bids:manage` Create and price staffing bids, manage clients and templates, send approved proposals | 11 |  | A | A | · |
| `bids:approve` Approve staffing bids and their margins before they go to the client | 11 |  | A | A | · |
| **Administration** | | |  |  |  |
| `modules:manage` Switch modules off (or back on) for the workspace, within what the plan includes | 27 | yes | A | · | · |
| `fields:manage` Add, change, reorder and archive custom fields on employee, asset, verification and other forms | 27 |  | A | A | · |
| **Background verification** | | |  |  |  |
| `bgv:view` View background verification cases, checks, findings and reports | 27 |  | A | A | · |
| `bgv:create` Start background verification for an employee, internally or with an agency | 27 |  | A | A | · |
| `bgv:edit` Work on checks: record findings and remarks, upload documents, share them with the agency | 27 |  | A | A | · |
| `bgv:delete` Cancel a verification case or remove a file from it (kept in the history) | 27 |  | A | A | · |
| `bgv:approve` Set the final verification result: verified, failed or on hold | 27 |  | A | A | · |
| `bgv:export` Export verification cases to Excel | 27 |  | A | A | · |
| `bgv:manage` Add and manage external verification agencies | 27 |  | A | A | · |
| **Assets** | | |  |  |  |
| `assets:view` View company assets and who holds them (own scope: the assets you hold) | 27 |  | A | A | T |
| `assets:create` Register assets and assign them to employees | 27 |  | A | A | · |
| `assets:edit` Change asset details, take returns, record maintenance | 27 |  | A | A | · |
| `assets:delete` Delete assets that were never assigned, or retire them | 27 |  | A | A | · |
| `assets:approve` Write assets off as lost or damaged | 27 |  | A | A | · |
| `assets:export` Download asset reports in Excel and PDF | 27 |  | A | A | · |
| `assets:manage` Manage asset categories | 27 |  | A | A | · |
| **People** | | |  |  |  |
| `tasks:assign` Assign Manager Tasks to people in scope and review their progress | 28 |  | A | A | T |
| `tasks:hr` Assign HR Tasks (documents, forms, acknowledgements) and verify the documents people upload | 28 |  | A | A | · |
| `profiles:review` Review the profile changes employees submit: compare, approve, reject or ask for more | 28 |  | A | A | · |

Legend: O own, T team, D department, E legal entity, A all (tenant), · not granted.

## 5.3 Level descriptions

- **Super Workspace** (`super_workspace`): Runs the whole company in SampCrew: every setting, every person, its HR Workspaces and its subscription.
- **HR Workspace** (`hr_workspace`): Looks after people: records, attendance, leave, documents, payroll, recruitment and requests, for the whole company or only the HR Workspaces named. What they use is limited by the modules given to them.
- **Employee Workspace** (`employee_workspace`): Every person: their own profile, attendance, leave, payslips, requests and learning, and approvals for the people who report to them.

## 5.4 Roles from before the access levels (kept for rollback, give no access)

The migration moved each person to the level below, with their exact previous permissions kept as limits. `pnpm db:migrate` runs it; the per-company rollback restores the old assignments from `access_level_migrations`.

- Workspace Owner (`tenant_owner`): Super Workspace
- Organization Admin (`org_admin`): Super Workspace
- HR Admin (`hr_admin`): HR Workspace
- HR Workspace Admin (`hr_workspace_admin`): HR Workspace
- HR Manager (`hr_manager`): HR Workspace
- HR Executive (`hr_executive`): HR Workspace
- Recruiter (`recruiter`): HR Workspace
- Hiring Manager (`hiring_manager`): HR Workspace
- Payroll Admin (`payroll_admin`): HR Workspace
- Finance Manager (`finance_manager`): HR Workspace
- Attendance Admin (`attendance_admin`): HR Workspace
- Department Manager (`department_manager`): Employee Workspace
- Reporting Manager (`reporting_manager`): Employee Workspace
- Employee (`employee`): Employee Workspace
- Auditor (`auditor`): HR Workspace

## 5.5 Console Admin (SAMPLEDGE Console)

Platform staff authenticate in a separate realm (`platform_admins` table, separate login, MFA mandatory). They have **no** access to tenant data by default. Viewing a tenant's data requires a time-boxed support access grant that the tenant owner approves, and every action is written to both the platform audit log and the tenant's own audit log.

| Capability | super_admin | support | billing_ops | viewer |
|---|---|---|---|---|
| `tenants:read` | ✓ | ✓ | ✓ | ✓ |
| `tenants:manage` | ✓ | · | · | · |
| `access:manage` | ✓ | · | · | · |
| `integrations:manage` | ✓ | · | · | · |
| `billing:read` | ✓ | · | ✓ | ✓ |
| `billing:manage` | ✓ | · | ✓ | · |
| `plans:manage` | ✓ | · | ✓ | · |
| `statutory:manage` | ✓ | · | · | · |
| `support:request` | ✓ | ✓ | · | · |
| `support:chat` | ✓ | ✓ | · | · |
| `help:manage` | ✓ | · | · | · |
| `help:answer` | ✓ | ✓ | · | · |
| `admins:manage` | ✓ | · | · | · |
| `audit:read` | ✓ | ✓ | · | · |
| `health:read` | ✓ | ✓ | · | ✓ |
