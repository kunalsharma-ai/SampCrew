# Candidate CRM (Recruitment & ATS)

Candidate CRM is a new section inside Recruitment & ATS, at `/recruitment/crm`. It works on the same candidate records as the ATS; nothing is copied. Applications, interviews and offers still live in the ATS, and the CRM profile links to them.

## Who sees it

| Level | Access |
| --- | --- |
| Super Workspace | Always on. Sees and exports every candidate in every HR Workspace. Manages access and settings. |
| HR Workspace | Only while Super Workspace has switched **Candidate CRM Access** on for it (CRM Settings). Sees only its own candidates, plus any that Super Workspace shared with it. |
| Employee Workspace | Never. The API refuses with `crm_not_available`. |

- **Switching off:** the menu item and pages disappear, and the API refuses with `crm_not_enabled`. The data is kept and comes back when the CRM is switched on again.
- **Powers per HR Workspace:** create custom fields, import, export, archive and erase, and see private details. Private details are gender, date of birth, nationality and restricted remarks.
- **Company-wide HR team:** people with HR Workspace access across the whole company are the "Company-wide HR team" row (key `central`).

## What works

### Overview
- Totals and conversion rates.
- My day (my follow-ups that are overdue or due today), plus the week's follow-up summary.
- Candidates by stage and by source.
- 12-week trend of candidates added and joined.
- Recruiter-wise table and recent activity.

### All Candidates
- Server-side search across name, Candidate ID, email, phone (any spacing), company and skills.
- Filters: stage, recruiter, source, reference, follow-up, HR Workspace, location, skills, tag, notice, experience, expected CTC, archived, and custom fields marked for filters.
- Column chooser, density and saved views (page `candidate_crm`), with pagination of 50 per page.
- Bulk actions: move stage, assign, tag, archive, and export selected.

### Add and edit candidate
- Sections A to E, plus links, source and assignment, references, custom fields, and confirmation that the candidate agreed to share their details.
- Duplicate check: the same email is refused. The same phone number asks first, then offers "Add anyway".
- Each candidate gets a `CAN-000001` number.

### 360° profile
- Header with photo upload, stage (with a note), recruiter, share (Super Workspace only), archive, and erase personal details.
- Tabs: Overview, Remarks (categorised and dated; restricted ones need the power), References, Activities, Follow-ups (complete, reschedule, missed, cancel), Documents, Jobs (ATS applications, interviews and offers) and Timeline.
- Documents: PDF, Word, image or text up to 10 MB. Uploading a new version keeps the earlier ones. Files are viewed or downloaded through the person's own session.

### Recruitment Pipeline
- 17 default stages, shown as a board, a table or a list.
- Drag and drop between stages, or use the stage menu on each card (keyboard friendly).
- ATS events move the CRM stage too, for example interview scheduled or hired.

### Follow-ups
- Buckets: overdue, today, upcoming, completed and missed.
- Filter by person, type and priority.
- A job runs every minute and sends notifications through the bell:
  - `candidate.follow_up_reminder`, before the follow-up is due;
  - `candidate.follow_up_due`, when it is due;
  - `candidate.follow_up_overdue`, when it is overdue.
- Assigning a follow-up or a recruiter also notifies the person.

### Activities
- Call, email, message, meeting and interview log with outcomes. A call needs an outcome.
- Logging an activity can schedule the next follow-up in the same step.
- Call-outcome summary, with filters by type, outcome, person and dates.

### Custom Fields
- 17 field types.
- Each field can appear in any of: form, profile, import, filter and export.
- Fields can be company-wide or belong to one HR Workspace.
- Reorder, edit, archive and restore. Archiving keeps the answers.

### Import
- `.xlsx` or `.csv` files, up to 5,000 rows and 8 MB, with a sample file to start from.
- Steps:
  1. Column mapping, guessed from the headings or taken from a saved mapping.
  2. Choose what to do with duplicates: skip, update, create, or decide row by row.
  3. Set defaults for source, stage, recruiter and tag.
  4. Check every row before anything is imported.
  5. Import, then download an error report.
- Import history is kept.
- Lenient parsing: "14 LPA", "6.5 yrs", "Immediate", "30 days", and portal names such as Naukri, which become Job Portal with the name kept as the source detail.

### Export to Excel
- Export the filtered list or everything, as `.xlsx` or `.csv`, with the columns you choose (including custom fields).
- Private columns are only offered to people with that power.
- Spreadsheet formulas in the data are neutralised.
- Every export is written to the export log and the audit log.

### CRM Settings
- Access switches and powers for each HR Workspace.
- Stages: rename, reorder, set what each one means, switch on or off, add new ones.
- Sources, duplicate match fields, and retention days.

### Candidate records
- Also found from the ATS candidate page, through "Open in Candidate CRM".
- Erasing personal details also clears CRM remarks, references, activity text, follow-ups, the photo and documents.
- The retention rule respects open follow-ups.

## Data

- **Migration:** `0110_candidate_crm`.
- **New collections:**
  - `candidate_crm_access`
  - `candidate_crm_settings`
  - `candidate_references`
  - `candidate_activities`
  - `candidate_follow_ups`
  - `candidate_imports`
  - `candidate_import_templates`
  - `candidate_exports`
- **New CRM columns on `candidates`:** `candidate_code`, `crm_stage`, `crm_hr_workspace_id`, `crm_shared_hr_workspace_ids`, plus the form sections.
- **Existing ATS candidates** get CRM fields and a Candidate ID the first time the CRM opens.

## Tests

| Command | What it covers |
| --- | --- |
| `cd apps/api && npx vitest run test/candidate-crm.spec.ts` | 18 API tests: access switch and isolation, duplicates, sharing, filters, the private-details power, stage and timeline, remarks, references, activities, follow-ups with reminders, documents and versions, custom fields, import, export log, overview, switch-off keeps data, archive and erase. |
| `pnpm e2e:candidate-crm` | The spec's scenario in the browser: Super Workspace switches the CRM on, the recruiter adds Kunal Sharma (gets `CAN-…`), schedules a follow-up, logs a call, moves him to Screening, sees it on the timeline, finds him in the list and pipeline, exports Excel, imports a CSV (duplicate and bad row reported, error report downloaded). Then switching off refuses the recruiter while Super Workspace still sees the data. It runs in CI after `e2e:ats`. |
| `apps/web/lib/help-content.spec.ts` | Covers every new page and section heading. |

- **Accessibility:** axe-core (WCAG 2.1 A and AA) found no serious or critical issues on the 16 CRM screens, in light or dark.
- **Screenshots:** `crew-preview/candidate-crm/` in the project files.

## Not included / notes

- **Pending part on existing installs:** the feature part `recruitment.crm` shows as **Pending** in the Console. Activate it there.
- **Email and WhatsApp:** messages are logged by hand. SampCrew does not send them from the CRM.
- **Reminders:** sent as in-app and push notifications through the existing bell. No separate email reminder.
- **Moving a record:** a record can be moved to another HR Workspace only by Super Workspace, through the API (`hrWorkspaceId` on PATCH). The edit form does not offer it yet.
