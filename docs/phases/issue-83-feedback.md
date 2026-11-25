# Issue #83: HR Admin and Employee portal feedback (2026-11-24)

No migration. Test: `apps/api/test/feedback-83.spec.ts`. New permission `mail:configure` (Super Workspace and
company-wide HR Workspace; new grants reach existing workspaces through the catalogue sync, and people whose old roles
were kept get it with `users:invite`).

## HR portal

| # | Asked for | What changed |
|---|---|---|
| 1 | A mail setup page for the company's email | Settings > Email setup (`/settings/email`, `GET/PUT /settings/mail`, `POST /settings/mail/test`). The company's own SMTP server (host, port, TLS or STARTTLS, user, password or API key, From name and address, Reply-To), with presets for Microsoft 365, Google Workspace, Zoho, Amazon SES and SendGrid. The password is encrypted with the field key and never shown again. While it is on, every email SampCrew sends for the company (invitations, password resets, notices) goes through it, otherwise through the platform's server. A test sends a real email and records the result. The page lists the latest emails and whether they went out. |
| 2 | Same-name employees | The duplicate check only warns about a matching name; it blocks only on the same email, phone or ID. |
| 3 | Resend verification email | "Resend invitation email" on the employee profile (login card) and in People. Without email set up the one-time link is shown to copy, with a link to Email setup. |
| 4 | Select All on permission pages | Select all and Clear for areas (full or view only), HR Workspaces, legal entities, departments, module groups, and each column of the Workspace Permissions and Employee Workspace feature boards (deselecting all asks first). |
| 5 | Favourites stay in place | Favourites sit above the scrolling menu. |
| 6 | Monthly leave credit, leave at registration, paid or unpaid | A leave type can be Paid or Unpaid and can credit N days every month (`monthlyCredit`, up to 31). The hourly leave job posts one adjustment per person per month (`accrual_key MONTHyyyy-mm`, unique), from the month the credit was switched on. The new-employee form asks for opening leave days for every hire, shows Paid or Unpaid and the monthly credit, and links to Leave types when there are none. |
| 7 | Ask for missing basics | Home tells Super and HR Workspace when there is no shift or no paid leave type yet, with a button to add one (`/org/overview` gives the counts). |
| 8 | Top bar | Only check-in, notifications and theme stay. Check in, Break, End break and Check out work from every page. The trial date is in the account menu, SampCrew IQ is a button in the bottom-right corner, Approvals, tasks, leave and help are in the menu and Create is in the search palette (Ctrl K). |
| 9 | Request several documents at once | The request form takes several document types; each one becomes its own request and task (`typeKeys`). A replacement still asks for one. |
| 10 | Announcements from HR | "New announcement or news" on the Announcements page for anyone who manages them, and "news" finds Manage announcements in the search. HR Workspace sees Announcements when the Super Workspace gave it the module. |
| 11 | Real retry time on lockout | "Too many failed sign-in attempts. Try again after 14 minutes." (and on the attempt that locks it). The same for the Console. |
| 12 | Attendance report formats | Export opens a dialog: Excel, CSV, Word or PDF; as on screen, one day, one week, one month, one year or a range; everyone visible or chosen employees; totals, day by day or both (`GET /attendance/export`). |
| 13 | HR cannot add leave types | Leave management shows for anyone who may allocate, assign quantities or create leave types. |

## Employee portal

| # | Asked for | What changed |
|---|---|---|
| 1 | Name not updating on Home | `/me` uses the employee record's name. |
| 2 | Employee ID | The field is always shown, with the next ID as its placeholder (`GET /employees/next-code`); leave it empty to use it. |
| 3 | Same-name employees | As HR 2. |
| 4 | Duplicate header icons | The approval inbox is gone from the top bar. Employee Workspace has no theme button there either; Appearance stays in the account menu. |
| 5 | Notices about your own actions | Nobody is notified about what they did themselves (security and system notices, and decisions made by the system, still go out). |
| 6 | Menu counts not clearing | Opening a module marks its notices read, so its dot clears. |
| 7 | HR applying leave for an employee | "Apply leave" on Leave balances opens the leave form for that person (`employeeId`). |
| 8 | CSV without details | The export now has department, designation, location, work email and joining date per person, and the day-by-day rows carry department, designation and location. |
