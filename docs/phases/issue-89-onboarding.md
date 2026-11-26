# Issue #89, leave rules and onboarding documents (26 November 2026)

Migration: `0210_onboarding_documents` (Learning parts made Active, notification sound on by default). New collections are made by syncCollections:
`form_settings`, `onboarding_doc_categories`, `onboarding_doc_items`, `onboarding_doc_templates`, `onboarding_checklists`,
`onboarding_library_requests`, `leave_status_rules`, `comp_off_requests` and `email_templates`. `document_requests` gains `checklist_id`, `library_item_id`,
`mandatory`, `max_files` and `extra_document_ids`.

## The 20 points
| # | What changed | Where |
|---|---|---|
| 1 | Legal name in the HR employee list | employees-view |
| 2 | "Workspace Sign In" wording | sign-in pages |
| 3 | Announcement attachments can be previewed and downloaded | announcements |
| 4 | The Super Workspace sets the automatic sign-out time | Settings > Workspace, session policy |
| 5 | LMS opens for HR, Super Workspace and Console | migration 0210, feature states |
| 6 | "Open the resource" opens the URL HR gave last, even on an assignment pinned to an older version | learning-common `withLatestLinks` |
| 7 | Notification sound plays (on by default) | notification-sound, migration |
| 8 | Review cycles removed from the sidebar | nav |
| 9 | Location verification: the accuracy bridge rule and clear reasons | work-mode, contracts `unverifiedReason` |
| 10-12 | The My Day / My Workforce (and Super Organization / Workforce) switch is in the sidebar instead of Filter menu; the menu changes at once | shell `HomeViewSwitch`, `homeViews` |
| 13 | Company email templates: import HTML for every email or one kind, placeholders, sandboxed preview, test send, back to standard | Settings > Email templates, mailer `applyCompanyEmailTemplate` |
| 14 | Home card titles are links to their page | `CardHeader href` |
| 15 | Work email domain (example, and optionally enforced) | Settings > Add Employee form |
| 16 | Pages answer at once: a loading screen inside the shell, and each GET runs once per render | `app/(app)/loading.tsx`, `lib/api.ts getOnce` |
| 17 | Add Employee fields: shown, required, label, help line (locked fields always on) | `/employee-form`, hire wizard |
| 18 | Documents that take several files (front and back, each mark sheet), and form field rules | document requests `max_files`, upload box |
| 19 | Import Employees link inside Add Employee | hire wizard |
| 20 | Onboarding documents assigned in the Add Employee form | hire wizard Documents step |

## Leave
1. No leave is typed in for a new joiner (the API refuses `openingLeaveBalances` for `joinedAs: new_joiner`). Existing employees still bring theirs.
2. Leave management > Leave rules: per type, no leave on probation, days credited on confirmation (optionally prorated). Credit is written once (`CONF{year}`) when an employee is confirmed.
3-4. Quantities and adjustments were already there (Leave management > Quantities, /leave/balances).
5. Comp-off: an employee asks for a weekly off or holiday worked (within 60 days); the manager approves, or HR from Leave management > Comp-off. Approval credits the comp-off type (`COMP{date}`). Needs a leave type of kind Compensatory Off.

## Onboarding documents
- Library: 35 documents in categories A to G and 8 templates, seeded once per company. The Super Workspace manages it; an HR Workspace only with the `manage_onboarding_library` document access switch, and never makes a sensitive document mandatory. HR can ask the Super Workspace for a document or the permission.
- Assigned at hire (atomically with the employee) or later from the onboarding list or checklist page. Each document is a document request and a task.
- Uploads go to HR approval; reject needs a comment; resubmission keeps every version.
- The checklist completes at 100% when every mandatory document is approved, and is archived (kept in the history).
- Pages: `/onboarding-documents`, `/onboarding-documents/[id]`, `/onboarding-documents/mine`, `/settings/onboarding-documents`.

## Tests
`apps/api/test/onboarding-documents.spec.ts` (brief scenarios 1-7), `apps/api/test/feedback-89.spec.ts` (form, leave rules, comp-off, email templates),
`packages/contracts/src/onboarding-email.spec.ts`, `packages/contracts/src/feedback-89.spec.ts`.
