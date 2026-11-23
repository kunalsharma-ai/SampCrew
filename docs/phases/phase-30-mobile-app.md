# Phase 30 report: one mobile app controlled by the Super Workspace, and the shared design layer

Kunal asked (21 November 2026) for a complete app redesign and one centralized mobile app controlled by the
Super Workspace. Leave, attendance, data import, learning, dashboards and documents were rebuilt in parallel
pieces of work, so this piece does not change their feature logic: it adds the mobile configuration, the
phone screens that were missing, and restyles the shared design layer once (Kunal's choice: "Shared design
layer only"), without reworking pages the other pieces edit.

## Working end to end

- **Mobile app configuration** (Web Portal, Settings, Mobile app): modules and features per level, bottom bar
  and order, Home widgets and quick actions per level, draft with a live phone preview, publish with a
  confirmation when it hides something people used in the last 30 days, history and restore, all audited.
  See `docs/ops/mobile-app-config.md`.
- **Server enforcement**: phone sessions are refused (`403 mobile_module_off`) on routes of hidden modules
  and features; the Web Portal is unaffected. The configuration never grants permissions and holds no secrets.
- **The phone follows it**: dynamic bottom bar and More, Home per level, "Not available in the app" for
  hidden screens, offline banner and cached configuration.
- **New phone screens**: Chat (conversations, people search, messages with read receipts and files), Email
  (inbox, and sent, drafts and compose for people who may email employees; says when email is not set up),
  Documents (open through short-lived audited links, upload where allowed), Learning (assigned courses, start
  and complete, course library and enrol), Attendance breaks, attendance history and team attendance,
  Announcements, Payslips, Employee directory, Search, Login and session details (sign-in history, sign out
  other devices).
- **Shared design layer (web)**: alerts with icons, empty states, skeleton shimmer, stat chips, button press
  feedback, table headers and row focus, applied everywhere through `@crew/ui`.

## Performance

Measured on the phone build as the QA lead (Employee Workspace):

| | Before | After |
| --- | --- | --- |
| Requests when Home opens | 120 (103 duplicates, a reload loop) | 17 (0 duplicates) |
| Requests when going back to Home | 79 | 1 |
| Greeting shown | | about 330 ms |
| Home tiles shown | | about 1.15 s |

Fixes: identical GETs in flight are shared and the last answer is shown at once while it refreshes;
screens reload on focus only after 15 seconds unless something changed; the configuration callbacks are
stable; long lists use FlatList; search is debounced; hidden tabs are frozen.

## Tests

- API: mobile app configuration (draft, publish, confirm, restore, enforcement), sign-in history, breaks.
- Browser flows on the phone build: `e2e/mobile-app-flow.cjs` (new, in CI as `pnpm e2e:mobile-app`),
  `e2e/mobile-flow.cjs` and `e2e/mobile-workspace-flow.cjs` all pass on a fresh database (21 November 2026).

## Merge order

This branch merges last, after the leave, attendance, data import, learning, dashboards and documents work.
The phone Leave screens here only gain a `ModuleGate` wrapper, so the leave rebuild's changes to them should be
kept as they are when merging. Regenerate `docs/api/openapi.json` after the final merge.
