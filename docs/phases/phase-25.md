# Phase 25 report: statutory settings for every country

Kunal asked (18 November 2026) to sell SampCrew outside India, with statutory settings to match, and to cover all
countries ("keep across all").

## Working end to end

- **Each legal entity uses its own country's scheme.** The country comes from the legal entity (Organization), so a
  workspace with an Indian company and a UK company pays each in its own rules. The API refuses India's scheme for a
  non-Indian entity, and another country's scheme for India or for the wrong country (`scheme_country`). If an entity
  later changes country, a payroll run stops until settings for the new country are saved (`statutory_country`).
- **India is unchanged.** PF, ESI, professional tax by state and TDS under the new regime work exactly as before; the
  existing India golden tests and API tests pass without changes.
- **A rules-based scheme for every other country** (`packages/contracts/src/payroll-countries.ts`), saved per legal entity
  with an effective date like India's:
  - *Contributions* (social security, pension, insurance, levies): employee and employer rates on gross pay or on
    contribution wages (components marked as such, e.g. Basic + housing in the Gulf), counted between a monthly
    threshold and a monthly ceiling, optionally only from a minimum, for everyone or only for people **enrolled** (the
    salary's first switch: nationals in the Gulf, CPF members, pension members). The employee share can reduce
    taxable pay (net pay pension, 401(k)).
  - *Income tax withheld by the employer*: annual slabs less an allowance, a levy on taxable pay (e.g. Medicare levy),
    a surcharge on tax, and a "flag for review above" amount. Cumulative over the tax year: what is still due for the
    year over the months left, the same method as India's TDS.
  - *Regional taxes*: extra slabs per state/province/canton, matched to the work location's region (US states).
  - *Tax year* starting in any month (January, April, July ...), and rounding to the cent or to whole units.
- **Ready-made country packs** (`statutory-packs.ts`), each with the period the figures were taken for and a plain
  "not calculated" note:
  - United Kingdom (2026-27): PAYE bands, employee NI 8%/2%, employer NI 15%, auto-enrolment pension 5%/3%.
  - United States (2026): Social Security, Medicare, Additional Medicare, federal withholding (single, standard
    deduction), 401(k) example, Illinois and Pennsylvania state tax as examples.
  - United Arab Emirates: GPSSA pension for UAE nationals 11%/12.5%, no income tax.
  - Saudi Arabia: GOSI annuities and SANED for Saudis, occupational hazards 2% for everyone, no income tax.
  - Qatar: pension for Qatari nationals 7%/14%, no income tax.
  - Singapore (2026): CPF 20%/17% up to the S$8,000 ceiling, Skills Development Levy, no monthly withholding.
  - Australia (2026-27): PAYG withholding from resident rates with the Medicare levy, superannuation guarantee 12%.
  - **Any other country** starts from a blank custom scheme (tax year from the entity's fiscal year, rounding by
    currency) that the workspace fills in.
- **Country packs live in MongoDB** (collection `statutory_packs`), not in code or the server's settings file. The
  packs above are copied in on every deploy (`syncCatalogueMongo`) only while SAMPLEDGE has not changed them. The
  **Console > Payroll country packs** page (`/statutory-packs`, `statutory:manage` to change, anyone with
  `tenants:read` to look) edits a pack with the same fields as the workspace editor, adds a pack for any other
  country, switches a pack off, resets a built-in pack to SampCrew's values and removes a pack SAMPLEDGE added. Every
  change is in the platform audit. Workspaces read starting values from the database; settings a workspace already
  saved never change when a pack does. API: `GET/PUT/DELETE /platform/statutory-packs/:countryCode` and
  `POST .../reset`; the scheme is checked against the country before it is saved (`statutorySchemeProblem`).
- **Settings > Payroll settings > Statutory settings** shows the entity's country, currency and pack, the notice that a
  local payroll advisor must check every value, and the right editor: India's sections for India, or contributions /
  income tax / regional taxes / notes for every other country. "Reset to the starting values" and "Start from a blank
  custom scheme" are there for both cases.
- **Salaries outside India** are an annual gross salary (India keeps CTC including employer PF). Employer contributions
  are shown as an estimate on top. The salary form shows only the switches that mean something in the country, with
  the country's names (e.g. "Enrolled in the workplace pension", "Income tax (PAYE)").
- **Payroll runs, payslips and the register** use the country's lines (`NI_EE`, `NIER_ER`, `PENSION_EE`, `TAX`,
  `REGION_TAX`, ...), the entity's currency, and year-to-date from the start of that country's tax year (per employer
  outside India). Payslips show regional tax year to date when there is any.
- **Demo data:** Northwind UK now has the UK pack saved (from the start of the tax year that holds last month) and a
  salary for Emma Clarke and Oliver Bennett, so a UK run can be tried straight away.

## Tests

- `packages/contracts/src/payroll-countries.spec.ts`: 15 golden tests by hand-worked figures: UK (NI bands, pension
  off taxable pay, PAYE cumulative over two months, high earner flag, proration), US (FICA, wage base cap, Additional
  Medicare, federal and state tax, a state with no table), Singapore (CPF ceiling and minimum, whole dollars, non-members),
  UAE and Saudi (contribution wages, nationals only), Australia (July tax year, Medicare levy, super), a custom scheme,
  the salary split outside India, tax-year helpers, pack validity and switch labels.
- `apps/api/test/payroll-countries.spec.ts`: starting values per entity, validation of the scheme against the country,
  a UK salary and payroll run approved and finalised, May carrying April's tax, the payslip's tax year, a German
  custom scheme paid end to end, and the change-of-country stop. Country packs in the database: listing, a Console
  edit reaching a workspace's starting values (support admins get 403), validation, adding and switching off a
  country, and reset (built-in packs cannot be removed).
- `e2e/console-smoke.cjs` (`pnpm e2e:console`): the Super admin adds a New Zealand pack in the Console, switches it
  off and removes it.
- `e2e/payroll-countries-flow.cjs` (`pnpm e2e:payroll-countries`, own CI step on a fresh demo workspace): the payroll
  lead opens Northwind UK's settings (UK pack, advisor notice, no PF/ESI), adds a contribution and saves a version,
  previews a UK salary, computes last month's UK run (NI, pension and PAYE in GBP), and finds India unchanged.

## Not yet / known limits

- **Starting values are not certified.** They follow commonly published figures for the period named in each pack and
  must be checked by a local payroll advisor; SampCrew does not track law changes by itself.
- **Person-specific rules are not modelled:** UK tax codes other than 1257L, Scottish/Welsh rates and the allowance
  taper (flagged above £100,000); US W-4 filing status and dependants; CPF age bands; Saudi annuity rates for new
  entrants after July 2024. Rates apply per legal entity, not per person.
- **Annual caps are spread per month** (US Social Security wage base, Australian maximum super base), so someone whose
  pay varies a lot through the year can be over or under by a little.
- **Not calculated anywhere outside India:** end-of-service gratuity accruals, employer-only levies on the payroll as a
  whole (US FUTA/SUTA, Australian payroll tax, UK apprenticeship levy), statutory sick/maternity pay, loans and
  garnishments, and government filing files (RTI, WPS, CPF submission, STP). These remain for a later phase or a
  payroll provider integration.
- **Starting payroll in SampCrew part-way through a tax year** works like India today: pay and tax already paid
  elsewhere this year are not imported, so the first runs project from the months left. Add an adjustment if needed.
- **Three-decimal currencies** (KWD, BHD, OMR ...) are kept to two decimal places; the settings say so.
- **Packs ship for 8 countries;** every other country works through the custom scheme the workspace fills in.
