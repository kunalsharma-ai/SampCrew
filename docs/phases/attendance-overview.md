# Attendance redesign: own attendance first, dashboards, Excel export and HR Workspace permissions

Part (2) of Kunal's 19 November 2026 specification. Every level sees its own attendance first. The Super Workspace and
HR Workspace then see the attendance they look after, with an Excel export of exactly that data. The Super Workspace
decides whether an HR Workspace may see other HR Workspaces' attendance.

## Working end to end

- **Who sees whose attendance is decided in the API** (`AttendanceAccessService`), not hidden in the pages:
  - *Super Workspace*: everyone in the company.
  - *HR Workspace*: the people placed in its own HR Workspace (company-wide HR: the central group, people with no HR
    Workspace) and itself. Never the Super Workspace people, never another HR Workspace's people or admins, unless the
    Super Workspace switched on **View other HR Workspace attendance** for it (all others, or only the ones picked).
    Even then the Super Workspace people stay out.
  - *Employee Workspace*: only itself. Kunal chose this ("Own attendance only, as spec"), so an Employee Workspace who
    runs a team no longer sees the team's attendance. Approving its people's leave and corrections still works.
  - The same rule now covers the existing screens and endpoints: the month register, one day (`/attendance/team`),
    corrections, one person's month (`/attendance/days?employeeId=`) and one day's detail. A person outside the rule
    gets "not found", so changing an id in the URL shows nothing.
- **Attendance page** (`/attendance`): a period bar (Today, This week, This month, Previous month, any month, a custom
  range up to 366 days), then *My attendance* (attendance % ring, present, absent, leave, half days, late, holidays,
  weekends, not counted), today's punches, late coming, and the month view or a paged date-wise history. For the
  Super Workspace and HR Workspace an **Attendance dashboard** follows: cards (HR Workspaces, people, overall %,
  present / absent / on leave / not counted today), a daily trend chart, and the two sections below.
- **HR Workspace Attendance** (`/attendance/hr-workspaces`, and one HR Workspace at `/attendance/hr-workspaces/:id`):
  each HR Workspace and the central group, with its admins, people, who is in today and its attendance %.
- **Employee Workspace Attendance** (`/attendance/employees`): employee-wise and date-wise views with search, HR
  Workspace, status today, level and sort filters, and pagination.
- **Excel export** (`GET /attendance/export.xlsx`, button on each page): an .xlsx with About (who exported, the period,
  the filters), Employees, Date-wise and HR Workspaces sheets. It uses the same filters and the same access rule as the
  screen, so it never holds a row the person cannot see. Up to 100,000 rows. Every export is in the audit log
  (`attendance.exported`). An Employee Workspace exports only its own attendance.
- **Attendance permissions** (`/settings/attendance-access`, Super Workspace with `hierarchy:manage`): per HR Workspace,
  View own attendance (always on), View its employees (always on), **View other HR Workspace attendance** (off by
  default, all or picked HR Workspaces) and Export attendance (on by default); for Employee Workspaces, Export my
  attendance. The permissions are a registry in `packages/contracts/src/attendance-overview.ts`, so a new switch is one
  entry. Saved in the new `level_permissions` collection; changes are audited (`attendance_access.updated`).
- **Calculation** (`attendanceTotals`): attendance % is present days out of working days. Working days leave out
  weekends and holidays; leave counts as a working day; half days count half; days not yet counted are left out.
  The same function feeds the screen, the API and the export.
- **Menu**: Month register, One day and Late coming are shown to the Super Workspace and HR Workspace only; Employee
  Workspace attendance and HR Workspace attendance pages and Attendance permissions are added.

## Tests

- API: `apps/api/test/attendance-overview.spec.ts` (calculation; Super sees everything; HR restricted including id
  tricks; Super grants and removes View other HR Workspace attendance; Employee Workspace own only; Excel matches the
  screen; the three levels agree). `attendance.spec.ts` updated for the Employee Workspace change.
- Browser: `pnpm e2e:attendance-overview` (`e2e/attendance-overview-flow.cjs`), its own CI step on a fresh database.
  It creates two HR Workspaces, walks every level, downloads and reads the Excel files, switches the permission on and
  off, and checks a phone-width screen. Screenshots: Library `crew-preview/attendance-overview/`.

## Not yet / known limits

- Days that were never computed are filled in when a page asks for them, but only for up to 300 people and periods of
  92 days or less per request; beyond that those days show as "not counted" until that person's month is opened or the days are recomputed
  (`POST /attendance/recompute`).
  "Today" is refreshed live for up to 1,000 people.
- The overview reads up to 5,000 people per request.
- No new feature switches were added: the pages use the existing Attendance feature, because new parts start off.
