# Phase 2 report: Core HR

Status: complete, pending product owner review.
Date: 2026-10-31.

## What was delivered

### Employees
- The employee is the person record. It can exist without a CREW login (for example shop-floor staff), and it can be linked 1:1 to a login later.
- Employee codes are allocated from a per-workspace series (`EMP0001`, and so on).
- Job details are effective-dated `employment_records`:
  - Hire, transfer, promotion, manager change, probation confirmation and extension, exit.
  - A change dated in the future stays pending until its date. A daily job then applies it.
  - A change is refused while a later one is already scheduled (`later_change_scheduled`).
  - Manager loops are refused.
- The current placement (entity, department, location and manager) is copied to the linked login automatically, so access scopes follow transfers.
- Lifecycle events are append-only.
- Exits are scheduled with a last working day. They can be withdrawn until then. On that day, the login is suspended and every session is revoked.
- Profile editing:
  - Employees can edit only their own contact fields.
  - HR edits the rest.
- Sensitive details (bank account, tax ID, national ID):
  - Encrypted at rest with AES-256-GCM.
  - Reading them needs the `employees:sensitive:read` permission and MFA.
  - Every view is audited, and the employee is notified when they change.
  - Redacted from audit diffs.
- Designations (job titles) can be managed by HR.

### Onboarding
- Checklist templates, each a list of tasks with an owner (HR, manager, employee or IT) and a due offset from the joining date.
- New workspaces get a "Standard onboarding" template.
- Hiring copies the template into concrete tasks:
  - Manager tasks go to the new joiner's manager.
  - Employee tasks go to the joiner's login once they accept the invitation.
  - IT tasks go to a shared queue for HR admins.
- People complete or skip their own tasks under "My tasks". HR can manage any task for employees they can update.

### Leave
- Leave types (paid or unpaid, half days, attachment rules, colour).
- Versioned policies per type, optionally limited to an entity or location:
  - Annual entitlement, monthly or yearly accrual and a carry-forward cap.
  - Notice days, maximum length, and whether leave is allowed during probation.
- Holiday calendars:
  - Each calendar has its own weekly offs and holidays (optional holidays are supported).
  - Calendars are assigned to locations.
- Balances come from an append-only ledger:
  - Entry kinds include accrual, used, reversal, adjustment, carry-forward and lapse.
  - Accrual is idempotent: each posting has a unique key, so re-running the job never posts twice.
  - Pending requests are shown separately from the available balance.
  - Day maths runs in decimal (`leaveMath` in `@crew/contracts`) and is shared by the API and the seed.
- Requests:
  - A live preview shows the working days (skipping weekly offs and holidays) and the balance after the request.
  - The request is validated against:
    - Overlap with other requests.
    - Balance.
    - Notice period and maximum length.
    - Probation, the joining date and the exit date.
    - Year boundaries.
    - Half-day rules.
  - Cancelling approved leave posts a reversal, so ledger rows are never edited.
- HR adjustments need a note, and nobody can adjust their own balance.
- The year-end close carries balances forward up to each policy's cap and lapses the rest. It can be run again safely.
- "Who's away" shows the team calendar view, limited to what the viewer may see.

### Approvals engine
- Generic, multi-step chains are configured per workspace and per request kind. Leave is the first kind to use it.
- A step can be:
  - The requester's manager.
  - The manager's manager.
  - Anyone with a given role.
- If no one in a role step is eligible, the step falls back to the Workspace Owner.
- Nobody can approve their own request, even when they have no manager.
- The approvals inbox lists what is waiting for the signed-in person. Approve or reject comes with an optional comment.
- Each request keeps its full decision trail.

### Documents
- Upload rules:
  - Uploads are multipart, up to 10 MB.
  - Allowed types are PDF, PNG, JPEG, WebP, DOCX and XLSX.
  - The content is checked against the declared type by its leading bytes.
- Visibility levels: employee-visible, or HR-only (hidden from the employee).
- Downloads only through a short-lived HMAC-signed link (5 minutes). Issuing a link is audited.
- Documents can be archived.

### Notifications and email
- In-app notifications, with a bell in the Web Portal header that shows unread items and supports "mark all read".
- Email is queued in the database and sent over SMTP when `SMTP_URL` is set.
  - Without SMTP, messages are marked "skipped". The product says invitation emails are not configured, rather than pretending to send them.
- Emails go out for invitations, approval requests and decisions, a new joiner for their manager, confirmation, and changes to bank or tax details.

### Background jobs
An hourly job, which also runs at start-up, handles:
- Applying due job changes.
- Activating joiners.
- Completing exits.
- Posting accruals.

Queued email is sent separately by the mailer, which checks the queue every few seconds and retries failures.

### Web Portal screens
| Area | Pages |
|---|---|
| Employees | Directory with filters and status; add employee (with optional invitation and onboarding template); profile tabs: Overview, Sensitive, Job (history, change, confirm or extend probation, schedule or withdraw exit), Leave, Documents, Onboarding |
| Leave | My balances, apply with live preview, my requests, cancel, team requests, who's away |
| Approvals | Inbox with approve and reject |
| My tasks | Onboarding tasks assigned to me |
| Settings | Leave types, policies, holiday calendars and location assignment, approval chain, run accruals, year-end close; onboarding checklist templates |

The People page from Phase 1 is now "Logins & access", since employees are the person records.

### Naming
On-screen text now says "Workspace" instead of "tenant", as agreed with the product owner. The owner role is now "Workspace Owner". Code, API paths and database tables keep the name `tenant`.

## Demo data
The demo workspace now has:
- 14 employees linked to logins, plus 3 without logins.
- Designations.
- Leave types CL, SL, EL, LWP and AL, with India and UK policies.
- An India calendar for the Pune plant and an England & Wales 2026 calendar.
- One pending and one approved leave request.

The holidays are a small sample entered as demo data. They are not an authoritative statutory list. Each workspace's HR enters its own.

## Tests

| Suite | Count | Covers |
|---|---|---|
| Contracts unit tests | 26 | Phase 1 tests plus leave maths (working days, half days, accrual proration, year close) and the new schemas |
| API integration tests | 91 | Phase 1 tests plus the 24 Core HR tests and an SMTP delivery test against a local SMTP server |
| Core HR browser test (`e2e/hr-flow.cjs`) | 1 flow | HR opens every Core HR screen, hires with manager, department, location and invitation, sees job record and checklist; the joiner accepts, completes a task, applies for leave with preview; the manager approves from the inbox; the joiner sees it approved and an unread notification |
| Web Portal and console browser tests | 2 flows | As in Phase 1, updated for the Workspace wording |

The Core HR integration tests cover:
- Hiring, validation and login linking.
- Directory scope, including staff without logins.
- Own-field edits.
- Encrypted sensitive data with MFA and audit.
- Future-dated transfers that move access when they apply.
- Immutable lifecycle events and probation.
- Leave set-up, idempotent accrual and the working-day preview.
- Leave flows: manager approval through the ledger, reversal on cancel, insufficient balance, rejection, no self-approval, multi-step chains, adjustments.
- Documents: signed links, HR-only documents, and content-type spoofing.
- Task permissions and notification isolation.
- SMTP not configured.
- Exit completion.
- Tenant isolation for every Phase 2 table.

CI now also runs the Core HR browser flow after the Web Portal smoke test.

### Defects found and fixed during this phase
- An HR admin's own leave request did not appear in the Workspace Owner's inbox when it fell back to them. The inbox now considers every role step.
- Scheduling an exit with a past last working day returned the record from before the exit was completed.
- A peer opening another employee's onboarding tasks got "forbidden", which confirmed the employee exists. It now returns "not found".
- An empty `SMTP_URL=` or `FILE_URL_SECRET=` line in `.env` stopped the API from starting.
- Notifications about an employee linked to the logins page instead of the employee profile.
- After adding an employee with an invitation, the portal moved straight to the profile, so the invitation link could not be copied. It now stays on the list and shows the link.

## Security verification
- Every new table has forced Row-Level Security and composite tenant foreign keys. A test checks each one across tenants.
- Every new route declares its permission, and the OpenAPI test checks every route is documented. The spec has 146 operations.
- Out-of-scope employees, requests, tasks and documents return 404.
- Sensitive fields are encrypted, MFA-gated, audited and redacted from audit diffs.
- Files:
  - Stored under random keys inside a per-workspace folder, with path checks.
  - Served only through signed, expiring links.
  - The content type is checked against the file's bytes.
- The leave ledger and lifecycle events are append-only. Corrections are new rows.
- No credentials are committed. SMTP and the file-link secret come from the environment.

## Known limits
- File storage is the local disk driver only. S3-compatible object storage is designed for but not connected, and the console health page shows it as not configured.
- Email needs an SMTP server and a sending domain with SPF, DKIM and DMARC. Without it, email is recorded as skipped.
- Role-based approval steps are resolved when the inbox is read. This is fine at current sizes, but it should move to a precomputed assignee table for very large workspaces.
- There is no statutory holiday feed. HR maintains holidays.
- Leave encashment is not built yet. It arrives with payroll in Phase 5.

## Next: Phase 3 (Attendance)
- Shifts and rosters.
- Web and mobile clock-in with geofences.
- Biometric device integration through vendor-documented APIs only.
- Raw punches kept immutable, with regularisation requests through the approvals engine.
- Overtime rules.
- Attendance feeding into leave and, later, payroll.
