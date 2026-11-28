# Issue #91 and the 27 November work file (SempCrew-query-part7-27.docx)

No migration: the rules of every form live in the existing `form_settings` collection (`employee_create` for Add
Employee, `form:<key>` for the others). Next free migration range is still 0220.

## What changed
| Item | What changed | Where |
|---|---|---|
| #91.1 Attendance time | Check-in, check-out and every clock on screen use the server's time, kept in step from the API (`serverTime` on `/attendance/today`), shown in the workspace time zone. A laptop with the wrong clock no longer changes what is recorded or shown. | `lib/server-clock.ts`, home header, attendance card, top bar punch, scan page, `todayIn()` for default dates |
| #91.2 Leave page | Order: leave count cards, My requests (collapse/expand, the five latest first, pending always shown, "Show all"), My leave calendar, then My leave types at the bottom. | `leave/page.tsx`, `MyRequestsCard` |
| #91.3 Form management | One page, Settings > Form management (`/settings/forms`), for every form: Add Employee, Employee profile, Leave request, Asset, Background verification case, Candidate, Client. Pick a form; set each built-in field shown/required/label/placeholder/help line; add, change, show/hide, require, reorder, archive or delete custom fields of any type. Only the Super Workspace changes forms; HR Workspaces see them read-only. | `/forms` API, `forms.ts` (contracts), settings/forms |
| #91.3 No mandatory defaults | Only First name is always on (a record needs a name). Every other Add Employee field can be hidden or made optional; a hidden joining date, legal entity or employment type falls back to today, the first legal entity and full time. | `EMPLOYEE_FORM_FIELDS`, hire wizard |
| #91.3 Dynamic forms | Add Employee shows the custom employee fields ("Additional details") and saves them with the hire (required ones checked). Edit details and My profile follow the Employee profile rules. Apply/Change leave follows the Leave request rules (reason label, required, placeholder) and shows custom leave fields. | hire wizard, employee Overview tab, profile, leave dialog |
| #91.3 Extra Fields | The old Custom fields and Add Employee form pages are gone; their links open the matching form in Form management, so "Extra fields" always opens and applies. | redirects, nav, settings hub, HR admin hub |
| Leave 1 | Leave is never typed in at registration (also for existing employees); quantities are set in Leave management afterwards. | hire wizard |
| Leave 2-5 | Already on main from issue #89 (leave by employment status, quantities from Super/HR, manual changes, comp-off). | Leave management |
| Images 1-9 | The attendance export dialog has a Report choice with the sample report templates: Monthly Leave Details, Monthly Present Report, Monthly Performance Report, Employees Date-wise Performance Report, Monthly Attendance Report (D01..Dn codes), Monthly Summary (Present, Absent, Work Hrs, OT, a column per leave code, Late, Early, Weekly Off, Holiday) and the In/Out punch register (In1-Out6, Dur, W.Hrs, Basic.Hrs, OT, Status). Each downloads as Excel, CSV, Word or PDF, with the same access rules and audit as the standard export. | `attendance-reports.ts` (contracts), attendance export |

## Choices made where the file was open to reading
- "No mandatory default fields": First name stays required, everything else optional and hideable.
- "Extra Fields not opening / not applying": read as the custom employee fields not showing on Add Employee, and the link
  opening a separate page. Both fixed.
- Custom field definitions can now be changed only by the Super Workspace (data import still creates fields it maps).
- File-type custom fields are filled in on the record after it is created, not on Add Employee or the leave form.
- A required custom leave field is checked when the form sends custom fields (web); the mobile app does not show
  custom leave fields yet, so it is not blocked by them.

## Tests
- `packages/contracts/src/feedback-91.spec.ts`: form definitions, rules, defaults, errors; every report template, day codes and totals.
- `apps/api/test/feedback-91.spec.ts`: Form management (Super only, HR 403, bad rules 422, audit), Add Employee with every
  field hidden and with a required field, Super-only custom fields and required custom fields at hire, Employee profile
  rules, Leave request rules and custom leave fields, `serverTime`, every report in CSV/Excel/Word/PDF, own-only for
  Employee Workspace.
- `e2e/form-management-flow.cjs` (`pnpm e2e:form-management`, own CI step): the whole flow in a browser, including the
  Leave page order and collapse, the report download and the home page clock with the browser clock four hours off.

## Fixed on the way
- `master-data.service` imported `employees.service` only for `uniqueAs`, which made an import loop once employees and
  leave used custom fields (the built API crashed at start). `uniqueAs` now lives in `employees/unique.ts`.
