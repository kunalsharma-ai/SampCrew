# Phase 24 report: late-coming reminders and attendance penalties

Kunal asked (17 November 2026) for:

- reminders to employees who come late, on their dashboard notifications and by email, sent both automatically and by
  hand;
- a salary deduction (a percentage, with criteria the admin sets) after a number of reminders, for example 3 or 5;
- monthly attendance and salary worked out from this;
- for leave applied on the same day, an option for the manager to apply a penalty of 2, 3.5 or more days, automatically
  or by hand.

## Working end to end

- **Rules, per workspace, all saved in the database and audited.**
  - *Settings > Attendance > Late-coming reminders* (attendance admins): on/off, automatic or by hand, "count arrivals
    late by at least N minutes" (after the shift's own grace time), email each reminder, tell the manager, and up to six
    deduction tiers. A tier is "after N reminders in a month, deduct X% of the month's gross pay" or "deduct N days of
    pay" (whole or half days). Only the highest tier reached in a month applies; tiers do not add up.
  - *Settings > Leave > Same-day leave penalty* (leave admins): on/off, automatic or by the manager, the penalty in days
    of pay (0.5 steps: 2, 3.5 ...), whether backdated leave counts, and leave types with no penalty (for example sick
    leave).
- **Automatic reminders.** When attendance computes a day as late (at the punch, on the hourly refresh, or when anyone
  opens the day), the employee gets an in-app notification (the notification bell, and a push on the mobile app) and, if switched on, an
  email. The text says when they arrived, by how much, which reminder of the month this is, and what the next tier
  deducts. One reminder per person per day. They are sent only for today and the two days before, and never for days
  before the rule was switched on, so recomputing old days sends nothing.
  - If a correction, a roster change or approved half-day leave shows the person was on time after all, the automatic
    reminder is withdrawn by itself, the person is told, and the month's deduction is worked out again.
- **Reminders by hand.** *Attendance & time > Late coming & penalties* lists every late arrival in the month for the
  people the signed-in manager or HR person can approve attendance for. **Send reminder** asks for an optional note
  (required when attendance does not show the day as late). Nobody can remind themselves. **Withdraw** takes a reminder
  back with a reason.
- **Late-coming deduction.** After each reminder or withdrawal, the month's deduction is brought in line with the live
  reminders and the employee is notified (and emailed) when one applies or goes up. A manager or HR can **Waive** it
  with a reason; it stays waived until a higher tier is reached.
- **Same-day leave.** Every leave request records the employee's local date it was made on. When the leave starts on or
  before that date it is marked **Same-day leave** on the request, in the approver's summary and in Approvals.
  - Automatic mode: the penalty is applied when the leave is requested, and the employee is told.
  - Manual mode: the approver sees the suggested days and can apply them, or another amount, from Approvals before
    approving (**Apply penalty**). The approver can change an automatic one too, and waive it from Late coming &
    penalties.
  - A rejected or cancelled request takes its penalty with it.
- **Payroll.** Each active penalty of the month is a deduction line on the payslip (`PEN1`, `PEN2` ...), with its
  explanation:
  - a percentage of the month's earned gross pay;
  - days of pay at monthly gross / days in the month.
  They come after PF, ESI, PT and TDS, so they do not change statutory amounts. A same-day leave penalty counts only
  once its leave is approved; payroll warns about one still waiting. Once payroll locks a month, its reminders and
  penalties cannot be changed.
- **Employees see their own month.** *Attendance* shows a **Late reminders and penalties** card: reminders this month,
  late arrivals, how many reminders are left before the next deduction, and what will be deducted.
- **Privacy.** Erasure blanks reminder notes and penalty reasons.

API: `GET/PUT /attendance/late/policy`, `GET /attendance/late/month`, `POST /attendance/late/reminders`,
`POST /attendance/late/reminders/:id/withdraw`, `POST /attendance/penalties/:id/waive`, `PUT /leave/same-day-policy`,
`POST /leave/requests/:id/penalty`. The Approvals inbox returns `details.sameDayLeave` for leave requests. No new
permissions: reminders need `attendance:approve`, same-day penalties `leave:approve`, the rules `attendance:configure` and
`leave:configure`. New collections `discipline_policies`, `late_reminders`, `attendance_penalties`; `leave_requests`
gets `applied_on` and `same_day`.

Tests: `apps/api/test/discipline.spec.ts` (12 API tests through HTTP and MongoDB, including a payroll run),
`packages/contracts/src/discipline.spec.ts` and a payroll engine test; browser flow `pnpm e2e:late`
(`e2e/late-flow.cjs`), its own CI step on a fresh demo workspace.

## Not yet working

- The mobile app shows the reminders as notifications (and push), but has no screen of its own for the month's late
  reminders and penalties; employees see that card in the Web Portal.
- Rules are one per workspace, not per legal entity or location.
- Late-coming deductions are counted per calendar month only, and a percentage is always of gross pay (not of basic).
- Email delivery needs email set up in Console > Integrations; until then reminders are in-app only and the email is
  recorded as skipped.
