# Report: role-based Home and the notification center

Kunal asked (21 November 2026, part 5 of the combined spec) for a Home built for each level: Console Admin, Super
Workspace, HR Workspace and Employee Workspace, a centralized notification center with menu unread markers, sound and
desktop settings, and notices inside the modules. Everything reads real data from MongoDB, and every figure is decided
by the API from the signed-in person's grants, never from the URL.

Migration: `0080_learning_notifications` moves earlier course notices from the Appraisal category to the new Learning
category.

## API

| Route | Who | What |
| --- | --- | --- |
| `GET /home/employee?month=YYYY-MM` | anyone with an employee record | the person's month of attendance (per day and totals), leave pending and coming up, learning with progress, announcements with the author's level, actions (missing punch, leave, learning, acknowledgements, tasks, approvals) and recent activity |
| `GET /home/workforce?date=&departmentId=&locationId=&hrWorkspaceId=` | HR Workspace admins, managers with team scope, Super Workspace | today's workforce (present, working now, not in yet, absent, late, on leave, missing punch, from home, left early), the HR action center, leave, employee overview, learning, communication. Scope is the person's own: an HR Workspace admin asking for another HR Workspace or the central group gets 404, an employee gets 403 |
| `GET /home/workforce/trend?days=7\|14\|30` | same | present / absent / on-leave share per day from stored attendance days |
| `GET /home/organization` | Super Workspace only | organization overview, health per HR Workspace (target 85 %), alerts, learning per HR Workspace, communication and recent HR activity |
| `GET /platform/home` | Console Admin | customers, workspaces at each level, active users, new workspaces, suspended, system alerts (backups, migrations, audit chain, outbox, scanner, integrations, plan requests, support access), administrative activity. Counts only: no employee is named |

`GET /attendance/team` also takes `filter=late|early_leave|working_now|not_in_yet|wfh`, so each Home card opens the
same list it counts. Notification preferences gain `desktop` and `quiet` (quiet hours, local time).

## Working end to end
- **Employee Home ("My day")**: greeting, name, level, workspace, date and live time; the attendance card with Check
  in, Start break, End break, Check out and Check in again (breaks are punches with the note "Break", so the
  attendance engine counts them); first in, last out, worked, break, expected and remaining time; status cards; an
  attendance calendar with month navigation, Today, a legend that filters, and a detail panel per day; month summary;
  leave with Apply leave; learning with progress; announcements with sender level and priority; recent activity;
  rewards and recent notifications.
- **HR Workspace Home ("My workforce")**: clickable workforce cards (each opens team attendance filtered the same
  way), filters for department, location and date (and HR Workspace for the Super Workspace), the HR action center,
  attendance monitoring, trend (week, two weeks, month) and calendar, leave, employee overview, learning (manage
  buttons only with permission), communication and quick actions by permission.
- **Super Workspace Home ("Organization")**: organization overview, Requires attention alerts, attendance trends,
  Workspace health cards (each opens that HR Workspace's workforce view), the HR Workspace performance table in name
  order (visibility, not a ranking), learning overview, communication and recent HR activity.
- **Console Home ("Platform overview")**: customers and workspaces at every level, system alerts, workspace health,
  administrative activity, sign-ups in the last 30 days, recently created, trials ending and subscriptions by plan.
- **Notification center**: the menu marks Leave, Attendance, Learning, Appraisal, Payslips, Tasks, Assets, Jobs,
  Profile, Background verification and Notifications with their unread notices, updated live; desktop notifications
  for background tabs (after the browser's permission); quiet hours hold back sound, pop-ups and desktop notices
  (urgent ones still come through); Attendance, Leave and Learning show their unread notices at the top, with mark
  read. Existing sound settings, pop-ups, the bell and the Notification Center are unchanged.
- **Live**: Home refreshes on notifications, approvals, leave and announcement events, and every minute on the HR and
  Super views.
- **States**: each section has its own skeleton, empty and error state (Try again), so one slow or failing source
  never blanks the page.
- The earlier customisable widgets (KPI strip, workforce charts, notes, announcements, setup, access) stay under
  "More for you".

Tests: `apps/api/test/home-dashboards.spec.ts` (scopes, refusals, isolation between companies, Console shows no
employee details, preference round trip), `e2e/home-flow.cjs` (`pnpm e2e:home`), and the updated workspace,
experience and console flows.

## Not yet
- Phone Home screens: the redesign work builds them, calling the `/home/*` routes above.
- Learning scores and progress percentages show once the learning work stores them; until then progress is 0 or 100.
- Desktop notifications appear only while a SampCrew tab is open (no service worker push yet).
