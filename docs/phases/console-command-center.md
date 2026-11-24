# Console command center

Kunal asked (22 November 2026) for the SampCrew Console to become a command center for SAMPLEDGE staff: one place to
run every client, subscription, conversation, security event and platform setting, with permissions enforced in the
API. He chose that one client company can hold several Super Workspaces.

## Structure

Company (client record) > Super Workspace > HR Workspace > Employee Workspace > people.

- `companies` (migration 0150) holds the client: profile, contact, address, tags, account manager, archive state and
  `field_sources` (which fields came from Brandfetch, and when). Every Super Workspace (`tenants`) has `company_id`;
  the migration created one company per existing Super Workspace.
- Company status is worked out from its Super Workspaces and subscriptions (active, trial, payment due, suspended,
  inactive, setup pending, archived). It is never typed in.

## Permissions (RBAC)

- Roles live in `platform_roles`: Super Admin, Admin, Finance Admin, Support Admin, Operations Admin, Read Only Admin,
  plus custom roles. Console > Roles & permissions shows the matrix and edits it (roles:manage). Super Admin always has
  every permission.
- The API reads the admin's role row on every request (`PlatformAuthGuard`), so a change applies on the next click.
  A refused call is audited as `platform.permission_denied`. Menu entries are hidden by the same permissions, but the
  API is the protection.
- Contact details of client users and companies need `users:pii`; without it they are masked in lists, the 360 view,
  search and the audit log. Users are found by full email only. The Console never shows employee records, messages,
  documents, payroll or attendance.

## Pages

| Menu | Page | What it does |
| --- | --- | --- |
| Overview | Command center (`/`) | Ranges (today, 7 days, 30 days, 3, 6, 12 months, custom), counts at every level, growth, revenue, subscriptions, payments, outstanding, needs action, renewals, fastest growing, activity, notifications, system status. Money needs billing:read. |
| Overview | Notifications | History by category and unread, mark read or unread, mark all; Preferences: muted categories, sound and desktop alerts (both off by default). |
| Overview | Reports | Business, workspaces, subscriptions, payments for a date range and company; CSV, Excel, PDF (reports:export, audited). |
| Clients | Clients | Status tabs, search, filters (plan, paid, industry, size, created, renewal, demo), sort, bulk tag, account manager, suspend, activate; CSV, Excel, PDF. |
| Clients | New company | Wizard: profile, first Super Workspace with its admin, plan, seats, trial; review; create. |
| Clients | Company 360 | Overview (profile, Brandfetch lookup, money, subscriptions, support, Super Workspace Admins), Workspaces (add, move, HR Workspaces), Users, Billing (invoices, refunds, credit notes), Activity (audit log for the company). |
| Revenue | Billing | New Refunds & credit notes tab. |
| Revenue | Plans | Impact (subscribers, MRR, revenue, invoices, why it cannot be deleted), duplicate, retire and reopen, impact preview before removing a module or lowering a limit. |
| Support | Support inbox | Priority and assignee on each conversation; the Console can start a conversation with a Super Workspace. |
| Security | Security | Sessions (sign out one or all of an admin's), sign-in history, suspicious activity, MFA coverage. |
| Security | Audit log | Filters (area, result, who, dates, Console only or also inside client workspaces), before and after values, IP and device, CSV/Excel/PDF export (audit:export, audited). |
| Security | Roles & permissions | The matrix and the role editor. |
| Platform | System health | Operational / Warning / Critical roll-up, traffic per service and the last 24 hours, next to the existing readings. |
| Platform | Settings | Workspace and user defaults, client communication, Console security, notifications, branding. Each section is saved on its own and audited with before and after. |

The top bar has global search (Ctrl+K or /), the notification bell (Notifications and System alerts tabs), the theme
switch and breadcrumbs. On a phone the menu opens from the top bar.

## Company data

Logo, description, LinkedIn, year founded and location can be filled from Brandfetch (Console > Integrations >
Company data, key in the database). Look up fetches by the company website and shows Brandfetch next to the profile;
the admin ticks what to keep. Saving fetches again on the server, so only what Brandfetch returned can be stored,
with its source and time. Nothing is guessed.

## View as

Console > Super Workspace > View as, only while the client has approved a support access request from this admin
and it has not expired. A banner shows the time left and Exit (which ends the approval at once). Every section opened
is logged in the client's audit trail and the Console's. Sections follow the admin's own permissions: users need
users:read (emails masked without users:pii), subscription needs billing:read.

## Refunds

Paid invoices can be refunded in full or in part, never beyond the invoice. Gateway refunds go through Razorpay or
Stripe; bank-transfer refunds record the reference. Each refund issues a credit note (`CN<fy>-000001`), is audited in
both trails, notifies the Console and the client's Super Workspace Admins. Only bank-transfer notes can be voided.
Refunds need billing:refund.

## Settings that act

- Session length and lockout: Console sign-in.
- Invitation expiry, owner access, trial days, default plan, region, two-step requirement: new workspaces and users.
- First answer target: tickets. Automatic reply and support hours: posted as SampCrew Support when a Super Workspace
  starts a conversation (none when the reply is empty).
- Renewal notice and inactive days: the command center and client statuses. Failed sign-in threshold: suspicious
  activity.
- Console name, support email and accent colour: the Console menu and highlight colour.

## Tests

- API: `apps/api/test/console-command-center.spec.ts` (roles, denials audited, masking, clients, notifications,
  dashboard money gating, search, reports and exports, audit before and after, company activity, security, plan
  impact, refunds, status, settings, automatic support reply, View as).
- Browser: `pnpm e2e:console-command-center` (fresh database), and `pnpm e2e:console` updated for the new home page
  and bell.

## Not changed or removed

- The old Platform audit page (last 100 events) is replaced by the filterable Audit log, which shows the same events
  and more.
- Super Workspaces (`/tenants`) and every page under it stay as they were; the Clients pages link to them.
