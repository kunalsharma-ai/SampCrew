# Design refresh, part 6: rate cards, candidate views, Excel export and mobile theming

Source: "CREW front end design" (see [design-1.md](design-1.md)). Part 5 ([design-5.md](design-5.md)) listed what
was still open from the document; this part builds all of it.

## What was built

### Bids: rate cards and one-off fees (migration 0019, `/staffing/rate-cards`)
- **Rate cards.** A rate card is a named list of agreed monthly pay and bill rates per role, for one client or for
  any client, in one currency. Cards are listed under Staffing, Rate cards. They can be edited or archived, and each
  change is audited.
- **Using a card on a bid.** A bid can follow a card for the same client (or any client) and currency.
  - Choosing a card fills the rates for roles it covers. Typing a role it covers fills the pay and bill rates.
  - Lines billed below the card are flagged on the line, in the summary, in the approval request and on the bid page.
  - The API refuses a card for another client, in another currency, or one that is archived.
- **One-off fees.** Fees such as mobilisation or training are billed on signing, on start or on delivery, with an
  optional cost. They are added to the contract value. Margin, the below-target check and the loss check use the
  contract totals.
  - Fees appear in the editor, on the bid page, in the approval summary, in the proposal email and PDF, and on the
    client's online proposal page.
  - The client never sees the cost of a fee.

### Excel export (`fflate`, no formulas)
- One shared writer produces a real .xlsx file with a bold, frozen header row, sized columns and plain numbers. Cells
  that look like formulas are kept as text, and leading-zero codes stay text.
- Excel export is available in three places:
  - **Employee directory** (`/employees/export.xlsx`): exports what is on screen, like the CSV export.
  - **Payroll run register** (`/payroll/runs/:id/register.xlsx`). The bank file stays CSV, the format banks take.
  - **Candidate list** (`/recruitment/candidates/export.csv|xlsx`).
- Every export applies the viewer's own access and is audited, with the file format recorded.

### ATS: candidate list, saved views and offer amounts
- **Filters and sorting.** The Candidates page uses the shared data table. It filters by job, by application status
  (in process, hired, rejected, withdrew, or not in a job), by source and by tag, and searches as before.
  - "Job" and "status" together mean the application for that job is in that state.
  - The list sorts by name, date added or last activity. Columns can be chosen, and rows can be compact.
- **Saved views.** Views are kept per person, as on the directory. One view can be the default, which opens when
  Candidates is opened.
- **Export.** CSV and Excel export the list on screen.
- **Comparing candidates.** People who can make offers on the job see an "Offer amount" row: the job's approved
  range, and each candidate's latest live offer with its pay period, any variable pay, and an "Above range" flag.
  Interviewers and hiring managers without offer access do not get pay in the response at all.

### Mobile app theming
- The app builds its colours with the same theme engine as the Web Portal (`buildTheme`), from the same saved
  preference. A theme chosen on the web shows on the phone, and the other way round.
- **Choosing a theme.** The Me tab has an Appearance card with:
  - Mode: match phone, light or dark.
  - Contrast: standard or high.
  - The twelve themes, each with a colour swatch.
- **Saving and fallback.**
  - Changes apply at once and are saved to the account. If saving fails, the theme goes back.
  - The last theme is kept on the phone for a fast start.
  - Signing out goes back to the default theme.
- **Radio state.** Selected options now report their state to screen readers on the web build (`aria-checked`). This
  also applies to the existing choice rows.

## Working end to end
- **Bids.**
  - Contracts tests cover fees and rate cards in `priceBid`: contract total, margin and the below-card count.
  - An API test (`bids.spec.ts`) covers card CRUD and audit, the refusals for client, currency and archived cards,
    fees in the bid, approval text, snapshot and public proposal, and fee costs hidden from the client.
  - Browser flow (`bids-flow`, step 6): the owner creates a rate card, builds an advanced bid that follows it, sees
    the rates filled in and the contract value with a fee, and saves it.
- **Excel.**
  - Unit tests for the writer (`tabular.spec.ts`). Its output was also opened with openpyxl.
  - The API test downloads the candidate Excel file.
  - Browser flows download Excel from the directory (`directory-flow`) and from the candidate list (`ats-flow`).
- **Candidate list.**
  - The API test (`recruitment.spec.ts`) covers each filter, name sorting, a bad status refused, a CSV row count
    matching the filter, the Excel file, an out-of-scope manager exporting nothing, and the export audit.
  - Browser flow (`ats-flow`, step 5): the recruiter filters to a job and people in process and sorts by name. They
    save that as their default view, reopen Candidates to get it back from the database, and export CSV (same row
    count) and Excel.
- **Offer amounts.**
  - The API test checks a recruiter sees the offer amount and "above range", and a hiring manager gets no pay.
  - The browser flow checks the row is shown.
- **Mobile theming.**
  - Unit tests (`theme.spec.ts`) cover mode resolution, and readable contrast for every theme, mode and contrast
    setting: text, muted text, buttons, links and selected chips.
  - Browser flow (`mobile-flow`): the QA lead picks Emerald in dark mode. The colours change, the choice is saved to
    the account and survives a reload, and a change made through the web API shows on the phone. Signing out leaves
    the theme behind.
- **Full run.** `pnpm test` passes: contracts 203, API 306, mobile 19. Every browser flow passes, run locally in CI
  order on one database. CI on GitHub runs again now that the repository is public.

## Not yet
- Rate cards are monthly rates only. Hourly or daily cards and card versions with effective dates are not built.
- Excel export covers the employee directory, payroll register and candidate list. Other reports still export CSV
  only, or nothing.
- The mobile app takes theme, mode and contrast from the saved preference. Custom colours chosen on the web are used
  too, but cannot be picked on the phone. Density, text size and motion settings are web only.
