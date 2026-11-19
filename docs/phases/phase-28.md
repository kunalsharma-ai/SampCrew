# Phase 28 report: the employee workspace

Kunal asked (19 November 2026) for an employee-facing SampCrew: a home dashboard built around the person's day, HR
Tasks and Manager Tasks with document upload and HR verification, an appraisal module, a complete profile with bank
and identity details kept encrypted and masked, profile changes approved by HR, interviews hidden from people who do
not recruit, the same on the mobile app, and a pass over layout and speed. About Us was dropped at Kunal's request.
Notifications, announcements, the leave engine and the approvals redesign were done in a separate piece of work, and
so were roles, custom fields, background checks and assets.

New permissions: `tasks:assign`, `tasks:hr`, `profiles:review` (migration `0020_employee_workspace_permissions` adds
them to the system roles of existing workspaces). Reward rules use `attendance:configure`; appraisal administration
uses the existing performance permissions.

## Working end to end, and not yet

### Working end to end
Each item runs against the real API and MongoDB and is covered by API tests and by two browser flows:
`e2e/workspace-flow.cjs` (Web Portal) and `e2e/mobile-workspace-flow.cjs` (the mobile app's web build at phone size).
Both ran green on 19 November 2026, with no browser errors, as did every other browser flow in CI after the
merges of #52 and #53.

- **Home, "My day"** (web): a live clock in the employee's time zone with Clock in / Clock out (the same punch,
  geofence and selfie rules as Attendance), first in, worked time, breaks and time left; leave balances with
  pending days; this month's attendance counts; attendance rewards; a month calendar of holidays, weekly offs,
  leave (approved and pending), task due dates and self-appraisal deadlines, with month navigation; task counts, and recent notifications (live, from the notifications work merged into this
  branch). Interview items, the interview task list and "Interviews this week" show only to people who can see recruitment.
- **Attendance rewards**: HR sets the rules under Settings, Attendance (perfect attendance, punctuality; late days
  allowed, leave types that do not count against it, half days, minimum working days). "Add the standard rules"
  excuses sick leave types. Each employee sees, per month, earned, on track, missed (with the reason, such as the
  first absent day) or not eligible. Only working days count; holidays and weekly offs never do. HR sees each
  finished month's winners per reward (with any missing attendance days computed first) and downloads them to Excel.
- **HR Tasks and Manager Tasks**: HR assigns HR Tasks (general, document upload, acknowledgement), managers assign
  Manager Tasks to people they manage, each person gets their own copy. Statuses new, not started, in progress,
  pending review, completed, reopened, cancelled, with overdue shown for open tasks past their due date. Document
  tasks accept the formats and size HR set; the upload goes to HR's verification queue, HR verifies or rejects with
  remarks, and a rejection reopens the task. Full history on every task.
- **Appraisal**: forms HR builds (sections, questions, weights, rating scale, bands, scoring method), with the
  Frequent Research evaluation as a ready-made template; cycles with a period, departments and three deadlines;
  launch sends everyone their appraisal. Self-appraisal, then manager evaluation, then HR review with per-question
  overrides and an approved final percentage with a reason; HR shares the result. Stages can be reopened.
- **Profile**: personal details, address, emergency contacts, education and previous jobs (with documents), skills,
  bank details and identity numbers. Work details are read-only. Employees send a change per section; HR compares
  old and new, approves, rejects or asks for more information, and only approval changes the record. Bank account,
  IFSC, PAN, Aadhaar and other ID numbers are stored encrypted (field keys, included in key rotation) and shown as
  the last four characters; the browser flow checks the full number never appears in the page.
- **Mobile app**: My tasks (HR and manager, open or all), a task screen to start, finish, acknowledge or upload the
  document with remarks: a photo (camera or library) or a PDF, Word or text file from the phone's files, limited to
  the formats and size the task allows; Appraisal (self-appraisal form with save and submit, and the shared result);
  My profile (masked numbers; requests to change personal details, emergency contact, address, bank account, typed
  twice, and skills; withdraw a pending change). Home gains a "My workspace" card and a My tasks quick action; Me links to all three.
- **Appraisal review on the phone** (follow-up): managers see a My team card (their turn when the self-appraisal is
  in) and score each question next to the employee's own score; HR sees an HR review card, scores, records an
  approved percentage that differs from the calculated one only with a reason, finalises and shares the result.
- **Reward payouts** (follow-up): each reward rule says what winners get: recognition only, a bonus in payroll, or
  extra days of one leave type. On Reward winners HR grants a finished month's winners their payout. A bonus becomes
  an earning line ("Reward: <rule> (<month>)") in the next payroll run of the person's legal entity, is marked paid
  when that run is finalised, and goes back for the next run if the person was held or the run cancelled. Leave is
  credited to the ledger at once. Each rule pays a person at most once a month (unique key), winners are decided
  again when granting, the payout is copied from the rule at that moment, every grant and take-back is audited, and
  winners are told. HR can take a grant back with a reason until its bonus is paid (leave days come off again).
  Employees see what a reward pays on Home. Migration 0034 marks existing rules "recognition only".
- **Phone app builds** (follow-up): `apps/mobile/eas.json` (preview and production profiles), a manual GitHub
  Actions workflow **Mobile build**, and `docs/ops/mobile-builds.md` with the accounts and keys only the owner can
  provide. Android and iOS JavaScript bundles compile and `expo prebuild` makes both native projects; the
  microphone, "draw over other apps", "always" location and motion purpose strings were removed, and
  `expo-system-ui` added so dark mode applies to the Android system bars.
- **Layout**: at 390 px wide, Home, tasks, appraisal, profile, profile updates and the attendance and appraisal
  settings have no sideways scrolling (the header, card headers and table screen-reader text used to push pages
  wider). Animations stay light and respect the reduced-motion setting.
- **Existing data**: migration 0020 was run against a workspace without the new permissions; it added exactly the
  ten grants the role templates give, changed nothing else, and does nothing when run again.

### Not yet working, or not yet verified
- **No reward certificates.** Rewards pay a bonus or leave; a printable certificate is not made.
- **Per-question HR overrides** stay on the web; the phone records HR's scores, remarks and approved percentage.
- **Mobile profile edits** cover personal details, emergency contact, address, bank account and skills. Education,
  previous jobs and identity numbers need their documents and are changed on the web.
- **Native builds not run end to end.** This environment cannot reach Expo's build servers or the Android SDK, so
  no APK or iOS build was produced and nothing was tried on a device. It needs an Expo token and the store accounts
  listed in `docs/ops/mobile-builds.md`.
- **Interviews on the web** are hidden from people without recruitment access; the data and the recruiter pages
  are unchanged.

## Tests
- API: `apps/api/test/tasks.spec.ts`, `appraisals.spec.ts`, `profile.spec.ts`, `workspace.spec.ts`;
  `packages/contracts/src/rewards.spec.ts` for the reward rules; `payroll.spec.ts` pays a granted reward bonus.
- Browser: `pnpm e2e:workspace` and `pnpm e2e:mobile-workspace`, run in CI on a fresh demo workspace.
