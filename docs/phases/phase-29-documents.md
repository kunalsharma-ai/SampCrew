# Phase 29 report: document management, verification and approval

This phase adds one document system for Super Workspace, HR Workspace and Employee Workspace:

- **Document requests** in four directions:
  - HR Workspace to an employee.
  - Super Workspace to an employee.
  - Super Workspace to an HR Workspace.
  - One HR Workspace to another, when Super Workspace allows it.
- **Verification**: the level that asked previews the file, then approves it, rejects it (a reason is required) or asks for a correction (instructions are required).
- **A Documents section on every profile**, including employee profiles and the HR Workspace page.
- **Centralized Document Management** for Super Workspace.
- **Document Access Management**: Super Workspace sets document switches for each HR Workspace, and the API enforces them.

Plan feature: `documents`. Permissions: `documents:read` and `documents:manage`. Migration: `0100_document_center`.

## Working end to end, and not yet

### Working end to end
Each item below runs against the real API and MongoDB. They are covered by `apps/api/test/document-center.spec.ts` (12 tests, including the nine scenarios of the brief) and by the browser flow `e2e/document-flow.cjs` (`pnpm e2e:documents`, added to CI).

- **Requests.** HR Workspace, or Super Workspace, asks one or more employees for a document, or asks an HR Workspace for one.
  - The request records the type, reason, instructions, deadline, priority, accepted formats, size limit and whether an expiry date is required.
  - Each person asked gets a task in My tasks (linked to the request) and one notification.
  - Statuses: New request, Pending submission, Submitted, Resubmitted, Under verification, Correction required, Rejected, Completed, Cancelled.
  - Overdue is worked out from the deadline. An hourly sweep sends one reminder two days before the deadline and one overdue notice to each side.
- **Upload.** Accepted files are PDF, JPG, PNG, Word (.doc, .docx) and Excel (.xls, .xlsx), up to 10 MB.
  - The upload area supports drag and drop and shows progress. Failures say why and save nothing.
  - The file's content is checked against its type, so a renamed file is refused, and the virus scan runs where it is configured.
  - Uploading never counts as approval: the file is "Pending" until someone verifies it.
- **Verification.**
  - The submission appears in Approvals under Document verification, and under Documents, Pending verification.
  - Opening it marks it "Under verification". The preview is inline for PDFs and images.
  - Approve, Reject and Request correction each ask for confirmation. Reject and correction need a comment.
  - Only the level that raised the request can verify it: HR Workspace cannot verify a Super Workspace request. The person who submitted can never verify their own document.
- **Versions.** A resubmission is a new version. The earlier version is marked Replaced, its file is kept, and the full history stays readable.
- **Expiry.** The expiry date is set at upload or at approval. An expired document is flagged once, with one notice. "Request replacement" asks for a new version linked to the old one.
- **Profiles.**
  - The employee profile Documents tab shows the person's requests, plus a table with search and filters for category, status, requested by and date. Each row shows who submitted the document, who requested it, who verified it, the expiry date and the version.
  - The HR Workspace page has a Documents tab with that workspace's own documents and the requests sent to it.
  - Employees see My document requests, Uploaded, Pending, Approved, Rejected and Correction required.
- **Centralized Document Management** (Super Workspace; HR Workspace sees its own part):
  - KPIs: total, pending verification, approved, rejected or correction, open and overdue requests, expired.
  - Tabs: All, Employee, HR Workspace, Requests, Pending verification, Approved, Rejected, Correction required, Document history, Document categories.
  - Server-side search matches every word of a name, title or reference. Filters and paging are available, and CSV export (records only, never files) is guarded against formula injection.
- **Document Access Management** (Settings, Document access, Super Workspace only):
  - There is one set of 15 switches per HR Workspace, plus one for company-wide HR.
  - Switches: enabled, view all/approved/pending, preview, download, HR Workspace documents, other HR Workspaces (read only, for chosen workspaces), request from other HR Workspaces, request, verify, approve, reject, correct, export.
  - Saving uses optimistic versioning and returns 409 when two people save at once. Every save is audited and the HR Workspace is told.
  - A change applies on the next request, including to file links: the browser flow switched downloads off and the direct `/files/:id` link returned 404.
- **Categories and types.** Built-in types are grouped as Identity, Employment, Education, Financial, Organizational and Other.
  - Super Workspace can add categories. Super Workspace, or HR with the request switch on, can add custom types.
  - Sensitive types (Aadhaar, PAN, passport, bank) hide the file name from anyone who cannot download the file.
- **Audit.** `document_activity` is append-only, enforced by database grants: every request, opening, upload, decision, preview, download, cancellation and access change, with the actor's level. Decisions and downloads also go to the audit trail.

### Not yet working, or not yet verified
- **Mobile app.** It still uses `/employees/:id/documents` and `/files/:id`, which are unchanged; the list returns the old fields plus the new ones. It uploads through the task. The phone has no screen for the request page, correction comments or Document access yet.
- **Legacy HR document tasks.** Document tasks created from the Tasks page before this phase, and new ones made with "Assign a task", still use the earlier verify flow (Verify or Reject on the task). Their files do appear in the central repository. New requests should be made with Request document.
- **No in-place e-signature or document templates.** "Documents and e-signatures" in the plan name covers e-signatures, which are not built.
- **Masking covers file names only.** The preview of a sensitive document shows the whole file to anyone allowed to preview it. There is no redacted preview.
- **No feature-part switches.** The Documents pages are not separate feature parts in the Console, because new parts start as "Pending". They are gated by the `documents` feature and the permissions.
- **Notifications** use the in-app channel and the user's existing email preferences. No new email templates were designed.
- **Preview** is inline for PDF and images only. Word and Excel files are downloaded, when the person is allowed to download.

## Database (`packages/db/src/mongo/schema.generated.ts`, migration `0100_document_center`)
- `employee_documents` now also holds HR Workspace documents. Changes:
  - `employee_id` is optional.
  - New fields: `owner_type`, `hr_workspace_id`, `request_id`, `type_key`, `doc_category`, `reference`, `version`, `previous_document_id`, `superseded_at`, `expires_on`, `expired_at`, `submitter_remarks`.
  - `verification_status` gains `correction_required`.
  - The migration fills `owner_type`, `version`, `reference` and `hr_workspace_id` for existing rows.
- New collections:
  - `document_requests`.
  - `document_activity`, which is append-only.
  - `document_access_settings`, one row per scope (`central` or an HR Workspace id).
  - `document_categories` and `document_types`.
- `employee_tasks` gains `request_id` and `request_status`.

## API (`apps/api/src/modules/document-center/`)
- Catalogue:
  - `GET /documents/catalogue`
  - `POST /documents/catalogue/categories`
  - `POST /documents/catalogue/types`
- Access:
  - `GET /documents/access`
  - `GET /documents/access/mine`
  - `PUT /documents/access/:scope`
- Repository:
  - `GET /documents/center/overview`
  - `GET /documents/center/documents`
  - `GET /documents/center/documents/:id`
  - `GET /documents/center/export.csv`
  - `GET /documents/center/activity`
  - `GET /hr-workspaces/:id/documents`
- Files: `POST /documents/:id/access-link` returns a 5-minute signed link and records a preview or download.
- Requests:
  - `GET /document-requests/targets`
  - `POST /document-requests`
  - `GET /document-requests`
  - `GET /document-requests/:id`
  - `POST /document-requests/:id/opened`
  - `POST /document-requests/:id/submit` (multipart)
  - `POST /document-requests/:id/review`
  - `POST /document-requests/:id/decision`
  - `POST /document-requests/:id/cancel`
- Existing routes changed:
  - `GET /employees/:id/documents` returns the richer rows and applies the access switches.
  - Profile upload and archive check the switches.
  - Request-linked tasks hand upload, verify and cancel to the request.
  - The approvals engine gains `decider` and `quiet` hooks for handlers.

## Permission logic
- **Super Workspace** sees and does everything, whatever the switches say.
- **HR Workspace** works within the switches for its scope.
  - A limited HR Workspace Admin uses the switches of their own HR Workspace.
  - Company-wide HR uses the `central` switches.
  - What they reach is also bounded by their grant (department, entity, HR Workspace), checked per employee.
  - An HR Workspace person whose documents grant covers only their own record (payroll or attendance leads in the demo) is treated as an employee.
- **Employee Workspace** sees their own documents, except those marked HR only. Managers keep read access to their team's documents.
- Everything is checked on the server. A document the viewer may not see answers 404, so its existence is not revealed. Signed links are issued only after the check, and each one is recorded.
- Nothing is deleted. Archive hides a document from the profile, and replaced versions are kept.

## Tests
- `apps/api/test/document-center.spec.ts`: 12 tests pass.
- Full API suite: every test passes.
- Web: typecheck, lint and the help-content checks pass.
- `pnpm e2e:documents` covers this sequence:
  1. Super Workspace requests a document.
  2. The employee finds it in Documents and My tasks and uploads it.
  3. Super Workspace previews it and asks for a correction.
  4. The employee uploads version 2.
  5. Super Workspace approves it; both versions and the history are shown.
  6. Downloads are switched off for HR: HR loses the Download link and the direct link returns 404.
  7. Downloads are switched back on and HR gets the file again.
- Screenshots: `crew-preview/document-center/` in the project files.
