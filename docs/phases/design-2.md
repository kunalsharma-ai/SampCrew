# Design refresh, part 2: enterprise table and guided hire

Source: "CREW front end design" (see [design-1.md](design-1.md)). This part reworks the busiest existing screen,
the employee directory, onto a shared table system, and replaces the one-page "Add employee" form with the
seven-step guided hire the document describes.

## What was built

### Shared data table (`packages/ui/src/components/data-table.tsx`)
- Sortable headers with `aria-sort`; sorting runs on the server, so it covers the whole list, not only the rows
  on screen, and paging keeps the order (keyset cursor on the sort key plus id, both directions).
- Column picker: show, hide and reorder columns; identifying columns (the name) cannot be hidden.
- Compact or comfortable rows, a sticky header row, toolbar slots for filters and actions, a footer with counts.
- The table state lives in the address bar, so any view can be bookmarked, shared or restored after a reload.

### Saved views (`/me/views`, migration 0012 `saved_views`)
- Save the current filters, sort, columns and density under a name; up to 20 per list; one can be the default and
  opens when the list is opened with nothing chosen. "All employees" always gets back to the plain list.
- When the table no longer matches the active view, the menu marks it as changed and offers "Update".
- Views are private to the person (row-level security plus an owner check on every call). A view only remembers how
  the list is shown; the list still applies the person's permissions.

### Employee directory (`/employees`)
- Eleven available columns: name, code, designation, department, location, legal entity, manager, work email,
  employment type, joining date, status. Sort by name, code, joining date, department, location or status.
- "Export CSV" downloads exactly the filters, sort and columns on screen (`GET /employees/export.csv`, up to
  20,000 rows), within the person's own scope. Cells that a spreadsheet would run as a formula are neutralised,
  the file opens correctly in Excel (UTF-8 BOM, CRLF), and every export is written to the audit log.
- "Shown of total" count, first and next page.

### Guided hire (`apps/web/app/(app)/employees/hire-wizard.tsx`)
1. Personal details (name, preferred name, date of birth, emails, phone, gender)
2. Employment (joining date, legal entity, designation, type, grade, probation)
3. Department and reporting (department and location filtered by the entity, manager)
4. Compensation: salary structure, annual CTC and start date, for people allowed to run payroll; others are told the
   payroll team sets pay
5. Documents: attach files with a title, category (guessed from the file name) and HR-only flag
6. Access and onboarding: onboarding checklist and the CREW invitation
7. Review: everything on one page with "Edit" links back to each step

- Duplicate check (`POST /employees/duplicate-check`) before leaving step 1 and again on review: existing records
  with the same work or personal email, phone, name, or name and date of birth, within the person's own scope,
  each with the reason it matched and a link. HR either corrects the details or confirms it is someone new.
- Save and resume: every step is saved to the server as a draft (`/employees/drafts`, migration 0012
  `employee_drafts`), private to the person who started it, up to 20 at a time. "Unfinished hires" on the directory
  shows each draft with the next step and a Resume button, on any device. Attached files are not stored in a draft.
- Completing the hire creates the employee, first job record and onboarding checklist (and invitation), then
  assigns the salary and uploads the documents in the same action, and removes the draft. If the salary or a
  document fails, the employee is kept and HR is told exactly what is left to finish.
- Server field errors take HR back to the step that holds the field.

## Working end to end
- Sort in both directions with gap-free paging, CSV columns and order, scope (a manager exports only their team),
  formula neutralising, audit entry, a bad column refused (API tests `experience.spec.ts`).
- Saved views: create, rename, one default per list, private to their owner, invalid state refused (API tests).
- Duplicate check (by name, refused without hire permission, nothing across workspaces) and drafts (save, update,
  private to their owner, nested data refused, discard) (API tests).
- In a browser (`e2e/directory-flow.cjs`): HR sorts by joining date, adds a column, switches to compact rows,
  saves that as the default view, reopens Employees and gets it back from the database, exports the CSV and checks
  its header and row count, starts a hire, is warned about an existing Sunita Patil, corrects the name, saves the
  draft, reloads, resumes at the right step, attaches an offer letter and completes the hire; the document is on
  the new profile and the draft is gone.
- The Core HR browser flow (`e2e/hr-flow.cjs`) now hires through the wizard (invitation, onboarding, leave,
  approval) and every earlier browser flow still passes.

## Not yet
- Compensation step: the salary call reuses the payroll endpoint that the payroll tests cover, but no browser test
  completes a hire with a salary (the demo HR admin cannot run payroll, and the payroll admin cannot hire).
- Column resizing and pinning, virtualised rows for very long lists, XLSX export, bulk select and bulk actions.
- Saved views for candidates (the API accepts them; the candidate list is reworked with the ATS views next).
- Bulk import of employees (CSV/XLSX with validation preview).
- Hire drafts hold personal details until the hire is completed or discarded; they are not yet included in
  privacy access exports or erasure, and there is no automatic expiry.
- Employee 360 profile layout, ATS kanban and other views, payroll stepper, CREW IQ panel and mobile theming
  remain for later parts.
