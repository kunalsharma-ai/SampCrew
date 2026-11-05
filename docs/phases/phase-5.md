# Phase 5 report: Payroll and finance

Phase 5 adds India payroll, payslips and expenses on top of Core HR, attendance and leave. Every amount is computed with exact integer arithmetic and carries a plain-language explanation. A run is prepared by one person and finalised by another.

**Statutory values are not certified.** CREW ships starting values for India (EPF, EPS, ESI, Maharashtra and Karnataka professional tax, and the new income tax regime). Each workspace must review and save them, per legal entity and with an effective date, before payroll can run. CREW does not claim they are current law for any period. Payroll staff remain responsible for statutory filings and challans, which CREW does not produce.

## What was delivered

### Money and the payroll engine
- `packages/contracts/src/money.ts` does all money arithmetic in integer paise (BigInt). Rounding is always explicit: half-up, up or down. The API and database exchange amounts as decimal strings, and the database stores `numeric(14,2)`.
- `packages/contracts/src/payroll-engine.ts` is a pure function for one employee-month. Its rules are documented in the file header and covered by golden tests:
  - **Proration** uses the calendar-day method.
  - **Provident Fund** is calculated on PF wages, with an optional wage ceiling. The employer share is split into EPS and EPF.
  - **ESI** applies while the contracted monthly gross is at or below the ceiling. Amounts are rounded up.
  - **Professional tax** uses the work location's state slabs, with a separate February amount where one is set.
  - **Income tax (TDS) under the new regime** projects annual taxable pay from year-to-date figures. It applies the standard deduction, slabs, the rebate with marginal relief, and cess. The tax still due is spread over the months left in the financial year.
  - **Surcharge** is not calculated. Income above the threshold is flagged for manual review.
- Every line gets an explanation, such as "INR 25,000.00 x 27.5 / 30 days" or "12% of INR 15,000.00 (PF wages INR 22,916.67, capped at INR 15,000.00)".

### Components, structures and salaries
- **Pay components** are earnings or deductions. Each is marked taxable, prorated by paid days, and counted as PF wages or not. Basic is required and always counts as PF wages.
- **Salary structures** are built from lines. A line is a fixed annual amount, a % of CTC or a % of Basic. One earning can take the balance, which is the CTC minus the other earnings and the employer's PF.
- **Salaries are effective-dated revisions.** Each revision stores its monthly breakdown, so a later edit to a structure never rewrites history.
  - A revision can be previewed before it is saved.
  - A revision can be removed only while no payroll has used it.
  - A revision cannot be dated into a month that is already finalised or waiting for approval.
- **Statutory settings** are saved per legal entity and effective date, never edited in place. Each also records where loss-of-pay days come from: attendance plus unpaid leave, or unpaid leave only.

### Payroll runs
A run covers one legal entity for one calendar month. It goes **Draft → Computed → Waiting for approval → Finalised**. It can be cancelled before it is finalised.

**Who is in a run:** everyone employed by the entity during the month who has a salary. People without a salary are listed as warnings.

**Loss of pay** is worked out per person:
- Approved unpaid leave on working days counts, with half days at the start or end.
- In attendance mode, an absent working day counts 1, or 0.5 when the other half was on leave. A half day counts 0.5.
- Missing punches are not counted. They are flagged for review instead.
- If a person has no punches at all in the month, CREW treats attendance as not in use for them. It counts unpaid leave only and raises a warning.
- Payroll recomputes the derived attendance days for the month first. Raw punches are never changed.

**Year to date:** taxable pay and TDS come from finalised runs earlier in the same financial year.

**Changes during the run:**
- **Adjustments** are one-off earnings or deductions, taxable or not, each with a reason. Examples are bonuses, arrears and recoveries.
- **Overrides:**
  - Loss-of-pay days can be set by hand.
  - Pay can be held for a person.
  - Both need a reason, survive recomputes and are audited.
  - A held person is left out of the totals, the bank file and payslips.

**Approval and finalisation:**
- **Submitting** recomputes the run, refuses negative net pay and sends the run to the approvals engine. The default approver is the Finance Manager role, falling back to the Workspace Owner. The preparer cannot approve, and approving needs a two-step-verified session.
- **Finalising** happens in one transaction:
  1. It freezes the run, its items and its adjustments. A database trigger rejects any change, even from a superuser connection.
  2. It locks attendance for the month.
  3. It marks the included expense claims as paid.
  4. It notifies everyone whose payslip is ready.

**Exports:**
- The **payroll register** is a CSV with every component per employee.
- The **bank transfer file** is a plain CSV for finalised runs. Account numbers are decrypted only for this export, and every export is audited, including the list of people missing bank details. Bank-specific file formats are not generated.
- CSV cells are protected against spreadsheet formula injection.

### Payslips
- Payslips are the included items of finalised runs.
- People see their own (`payslips:read` own). Payroll sees those in scope. When anyone other than the employee opens a payslip, the view is audited.
- The printable page shows every line with its calculation, employer contributions, year-to-date totals and a demo notice in the demo workspace. Use the browser's "Save as PDF" to get a file.

### Expenses
- **Categories** set whether a receipt is required and a limit per claim.
- **Claims:**
  - A claim is made in the legal entity's currency.
  - It cannot be dated in the future.
  - The receipt can be a PDF, JPEG or PNG up to 5 MB. Its content is checked against its type and its SHA-256 is stored.
- **Approval** goes to the employee's manager through the approvals engine, falling back to Finance Manager. Managers can approve or reject on the Expenses page.
- **Receipt links** are HMAC-signed for receipts specifically, last 5 minutes and are audited.
- **Payment:** approved claims dated up to the end of the month are reimbursed, tax-free, in the next run for that person. They are marked paid when the run is finalised.

### Who can do what

| Role | Payroll | Expenses |
|---|---|---|
| Payroll admin | Read, run, configure; payslips for the workspace | Approve |
| Finance manager | Read, approve (finalise) | Approve |
| Department manager | No access | Approve for their team |
| Employee | Own payslips | Submit own |

- `payroll:*` permissions need a two-step-verified session.
- HR admins administer people, not pay, so they have no payroll access by default.
- Out-of-scope runs, salaries, payslips and claims return 404.

### Web Portal screens
- **Payroll runs** lists runs, flags legal entities without saved statutory settings and creates a run.
- **Run page:**
  - Actions: compute, recompute, send for approval, withdraw or cancel.
  - Totals and grouped warnings.
  - The payslips table and adjustments.
  - CSV downloads.
- **Payslip calculation** shows every line with its "how", the explanation, days and tax. It is also where loss-of-pay overrides and holds are set.
- **Salaries** lists everyone's current CTC. The per-person history shows the breakdown, with preview and save for a new revision.
- **Payroll settings:**
  - A statutory editor per legal entity covering PF, ESI, professional tax states and slabs, and TDS slabs.
  - The saved history.
  - Components, structures and expense categories.
- **Payslips** shows your own payslips, plus "everyone I can see" for payroll staff. Each payslip is printable.
- **Expenses** has three views: your claims with a submit form, claims waiting for you, and all claims you can approve.

## Demo data
- **Northwind India** has saved statutory settings: the starting values, saved from the start of the financial year as demo data.
- **Every India employee has a salary,** from INR 2.16 lakh to INR 48 lakh a year, using the Standard structure.
- **Expense claims:**
  - Arjun has an approved Travel claim dated last month, which the first run reimburses.
  - Neha has a pending Meals claim waiting for her supervisor.
- **No payroll run is seeded,** so the first run can be tried end to end.
- **Northwind UK has no payroll:** statutory rules in this release cover India only.

## Tests
- **Contracts:** 60 unit tests, including 14 golden payroll engine tests.
  - Proration with half days.
  - The PF ceiling and the EPS split.
  - ESI eligibility and rounding up.
  - Professional tax, including February.
  - The rebate, marginal relief and cess.
  - TDS spread with year-to-date figures.
  - CTC splitting and its errors.
- **API:** 149 integration tests across 12 files. `test/payroll.spec.ts` adds 16 that run a complete month through HTTP:
  - **Access:** the plan gate (402), MFA (403 `mfa_required`) and no payroll access for HR or employees.
  - **Settings and salaries:**
    - No statutory settings are stored by default, and slab validation is enforced.
    - Component and structure checks.
    - A salary preview of 25,000 / 10,000 / 13,200 with employer PF of 1,800.
    - Salary amounts kept out of the audit trail.
  - **Loss of pay:**
    - From real punches and unpaid leave: 1 absent day + a half day + 1 unpaid leave day = 2.5.
    - The no-attendance fallback.
    - A mid-month joiner.
  - **Exact figures:** gross 44,183.34 and net 42,183.34; ESI at 71 rounded up; PT of 175 and 200.
  - **Expenses:** limits, receipt sniffing, manager approval, 404 for colleagues, signed receipt download and forged-signature rejection.
  - **Changes during a run:** adjustments and overrides with reasons, and recompute.
  - **Finalisation:**
    - Approval by someone other than the preparer.
    - The database freeze.
    - The attendance lock.
    - Claims paid and payslips announced.
  - **Next month:** carries year-to-date taxable pay into the following month's TDS.
  - **Payslips:** own-only payslips.
  - **Exports:** the register CSV and the audited bank file with decrypted accounts. Finance gets 403 on the bank file.
  - **Isolation:** of all 11 new tables, by database role and by API.
- **Browser:** `e2e/payroll-flow.cjs` runs in a real browser and fails on any browser error:
  1. The payroll lead is blocked until two-step verification is on.
  2. They review settings and preview a salary.
  3. An operator claims an expense with a receipt, and a supervisor approves one.
  4. The payroll lead computes last month, inspects a calculation, adds an adjustment and submits.
  5. Finance enrols MFA and approves.
  6. The register downloads, and the operator opens their payslip with the allowance and the reimbursed expense.

  CI runs it after the recruitment flow.

### Defects found and fixed during this phase
- A colleague asking for someone else's expense claim got 403, which confirmed the claim exists. It now returns 404.
- When many people shared the same warning, the run page listed it once per person. Identical warnings are now grouped.
- Long amounts wrapped inside table cells and overflowed the totals cards. Both are fixed.

## Security verification
- **Tables:**
  - All 11 new tables have forced Row-Level Security and composite workspace foreign keys.
  - Salaries and statutory settings are insert-only history for the API role, plus delete for unused rows.
  - A finalised run is frozen by trigger.
- **Routes:** every new route declares its permission and plan feature (`payroll` or `expenses`). The OpenAPI spec now has 286 operations.
- **Two-step verification:** payroll permissions require it, and approval decisions re-check it.
- **Separation of duties:** the preparer cannot approve their own run, which the approvals engine enforces. Payroll admins cannot approve payroll by default.
- **Bank details** are decrypted only inside the audited bank-file export. Salary amounts are not written to the audit trail, because auditors and HR can read it.
- **Receipts** are checked by content, size and type, and served only through short-lived links signed for receipts.

## Known limits
- **India only.** Statutory rules cover India. Other countries' entities cannot run payroll yet; global payroll is a later, provider-based phase.
- **Statutory coverage:**
  - No surcharge (flagged instead).
  - No old tax regime.
  - No investment declarations or proofs.
  - No Form 16 or 24Q.
  - No PF ECR, ESI or PT challan files.
  - No labour welfare fund or gratuity accrual.
- **Mid-month salary changes** use the new salary for the whole month, with a warning. Split the difference with an adjustment.
- **No arrears automation, loans or advances, full and final settlement, or bonus and variable pay plans.** Use adjustments.
- **Held pay** is not carried forward automatically. Release it in the next run with an adjustment.
- **The bank file is a generic CSV**, not a specific bank's upload format. There is no payment initiation.
- **No PDF generation on the server.** Payslips print to PDF from the browser.
- **Expenses:** only in the entity's currency, with no mileage rates, per-diems or receipt OCR, and no virus scanning.
- **The payroll browser test needs a fresh database,** because it turns on two-step verification for the demo payroll and finance users.

## Next: Phase 6 (Performance and talent)
- Goals and reviews.
- Learning.
- Engagement.
