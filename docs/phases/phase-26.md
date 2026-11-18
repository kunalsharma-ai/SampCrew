# Phase 26 report: a better create employee form

Kunal asked (18 November 2026) for these changes to creating an employee: a date of birth calendar linked to the
joining date (minors included), a work email that is never the personal email, proper phone number checks on every
form, a longer designation list that also takes any typed title, and a way to add people who already work at the
company, not only new joiners.

## Working end to end

- **Date of birth calendar, linked to the joining date.** The hire form, and the profile's Edit details, use a new
  calendar (`DatePicker` in `@crew/ui`) with month and year lists, so a birthday decades back is two clicks away. It
  opens around 25 years before the joining date and offers only dates that make the person 14 to 100 on the joining
  date; the joining date calendar in turn starts on their 14th birthday. Someone under 18 on the joining date (a
  minor) can be hired only after HR ticks a confirmation that the law allows it and the guardian's consent or work
  permit is on file. The API enforces the same rules (`dateOfBirthError`, `isMinorOn` in
  `packages/contracts/src/schemas/people.ts`) for every way an employee is created, and records the confirmation and
  the age on joining in the audit trail. A later change of the date of birth on the profile is checked too.
- **Work email.** The work and personal email fields no longer invite the browser to fill them in with the signed-in
  HR person's own address (`autocomplete="off"`, password managers told to skip them). The API refuses a work email that
  is the personal email (on the hire and on the profile). When colleagues already have work emails, the form offers
  one in the company's format, such as `priya.sharma@acme.com`; public mail domains such as gmail.com are never offered.
- **Phone numbers, one set of rules everywhere** (`packages/contracts/src/phone.ts`). Only digits, spaces, brackets,
  dashes and a leading + (or 00). With a country code, 8 to 15 digits; numbers for India, the US and Canada, the UK,
  the UAE, Saudi Arabia, Qatar, Singapore and Australia are checked against that country's numbering plan (length and
  first digits), others against the international rules. A local number is checked against the legal entity's
  country (the hire and profile) or the company's country (setup). Placeholders such as 0000000000 or 1234567890 are
  refused. Used by the API schemas for employees, candidates, careers site applications, company setup and email
  signatures, and checked in the browser before sending on the hire form, profile, candidate forms, careers
  application form, setup and signature pages. The mobile app has no phone number field.
- **Designations.** The ready-made library now holds over 200 titles across management, HR, finance, sales,
  operations, technology and each industry (`designationLibrary()` in `packages/contracts/src/setup.ts`). The hire
  form's Designation field suggests the workspace's own designations first, then the library, and takes any typed
  title: one that matches an existing designation (in any case) uses it, any other is added to the designations with
  the hire (with the library's code and level when it is a known title). Company setup still ticks a short list per
  industry.
- **Someone already working here.** The first step of the hire asks who is being added. For an existing employee:
  - the joining date can be any day up to today (not in the future);
  - they can keep their employee code (checked for clashes) or take the next code in the series;
  - their status is worked out: confirmed on the date HR gives, or the day after their probation ended, or still on
    probation; a `confirmed` lifecycle event is recorded when confirmed;
  - no joining checklist is started unless HR picks one, and their manager is told they were added rather than that
    they "join on" a past date;
  - the leave available to them today can be entered per leave type. SampCrew posts this year's accrual as usual and
    then one adjustment (`accrual_key` `OPEN<year>`) that brings the balance to that number. This needs the same access
    as adjusting a balance (`leave:approve`).
  - The record keeps `joined_as: existing` (new optional column on `employees`; older records read as new joiners).

## Tests

- `packages/contracts/src/phone.spec.ts`: phone rules per country, date of birth and minor rules, work email, the
  designation library and existing-employee input.
- `apps/api/test/hire-form.spec.ts`: the same rules through the HTTP API, including local numbers against the legal
  entity's country, typed designations created once, and an existing employee's code, confirmation, checklist and
  opening balance.
- `e2e/directory-flow.cjs`: in the browser, the phone and work email errors, picking a date of birth from the calendar,
  the joining date limit, a typed designation, and adding an existing employee whose leave tab shows the opening
  balance. `e2e/setup-flow.cjs` now types the designation instead of using the old "New designation" button.

## Not yet

- Opening balances are for the current leave year only. Earlier years' history (leave taken in 2024, say) is not
  imported; the data migration tools will bring that.
- Bulk import of existing employees from a spreadsheet is still to come; this adds them one at a time.
- The minimum working age is 14 for every country. Countries with a higher minimum (or extra rules for minors) are
  covered by HR's confirmation, not by a per-country setting.
