# Design refresh, part 4: closing the open items

Source: "CREW front end design" (see [design-1.md](design-1.md)). Part 3 ([design-3.md](design-3.md)) listed what
was not yet built; this part builds those items: proposal fonts, client acceptance, bulk ATS actions, Employee 360,
the payroll stepper, CREW IQ and the remaining Workforce Universe views.

## What was built

### Proposal PDFs in every script
Proposal PDFs embed Noto Sans with per-script fallbacks (Devanagari, Greek, Cyrillic, Vietnamese and Latin), so
client and people names print correctly instead of as replacement characters.

### Client acceptance link (migration 0014, `/proposal/:token`)
- Every recipient of a proposal email (to and cc) gets a private link of their own; only its SHA-256 is stored.
  The email says who the link is for and until when it works.
- The client opens the proposal without an account, reads it, downloads the PDF, and accepts with name, title and
  a typed signature, or declines with a reason. One decision per bid.
- Accepting marks the bid won, stores a signed copy of the PDF (with the signer, time and address on a final page)
  and notifies the owner by email; declining marks it lost. The bid page shows views, the decision and the signed
  copy. Links stop working when the bid is withdrawn or replaced, or when they expire.

### Bulk ATS actions (`POST /recruitment/requisitions/:id/applications/bulk`)
Tick candidates, or a whole stage, on the job board, then move them to a stage, email them (`{firstName}` and
`{jobTitle}` filled in per candidate) or reject them with a reason and an optional neutral email. Each application
is checked on its own with the same rules as one by one; skipped ones are named in the result. Audited per action.

### Employee 360 (`GET /employees/:id/360`)
An at-a-glance strip on every profile: tenure, attendance over 30 days, leave, pay, goals and the latest released
rating, learning, recognition, open requests and documents, and an Activity tab that merges the timeline. Each
area appears only when the plan has the module and the viewer's own access covers this person for it (HR admins
without payroll access never see salary; employees see their own payslips only).

### Payroll run stepper
Every payroll run shows Period, Inputs, Compute, Review, Approval and Publish, worked out from the run itself, with
what to do next.

### CREW IQ (`POST /iq/ask`, top bar button and Ctrl+J)
- A side panel that answers from the workspace under the asker's own permissions: approvals waiting, pending
  onboarding tasks, who is on leave, the leave trend, headcount by department, departments with rising overtime
  and a recruitment summary. Questions are matched to these intents by plain rules (`matchIq` in
  `@crew/contracts`), so figures come from records, never from a model.
- Each answer says how sure it is ("From your records", "Matched articles", "Not sure"), how it was found, and
  links to its source pages. Policy questions are answered from help articles, and by the AI assistant when the
  workspace has it on.
- Actions never change anything: "Create a staffing proposal for five recruiters" shows a preview and opens the
  Quick Bid with 5 × Recruiter filled in; "Prepare a draft job description for a Senior HR Manager" opens the
  requisition form with the title and a draft description. Nothing is saved until the person saves it.
- Rate limited to 30 questions a minute per person.

### Workforce Universe lenses (`/insights/universe?lens=…`, migration 0015)
- **Locations**: an orthographic globe (drag or the buttons to turn it) with a dot per location sized by headcount
  on the chosen date, and a table with the change against a year earlier. Locations without coordinates are
  counted and listed but not drawn.
- **Skills**: people's skills with a level (Learning, Working, Strong, Expert), edited from a Skills card on the
  profile by anyone whose access lets them update that person, including the person. Drawn as a network (skills
  on a ring sized by holders, people near the skills they hold, coloured by department); skills with one or two
  strong holders are marked red or amber. A department filter and a summary table.
- **Recruitment flow**: for applications made this quarter, this year or ever, on the jobs the viewer can see,
  how many reached each stage, moved on, were turned down or withdrew, and the conversion, from the application
  event log. Drawn as a funnel with a table.
- **Scenarios**: what-if headcount changes per department, saved for others to open. Monthly cost (current salary
  / 12, and a cost per added person) is shown only when the viewer's payroll access covers everyone counted, so a
  partial figure never passes for a total. Saving is for people with reports access beyond their own records.
  Scenarios are plans only.

## Working end to end
- Proposal fonts, acceptance and decline: API tests in `bids.spec.ts`; in a browser (`e2e/bids-flow.cjs`) the
  client opens their link from the email, accepts with a signature, the bid shows won with the signed copy.
- Bulk actions: API tests in `recruitment.spec.ts` (moves, emails, rejections, skips, scope and validation); in a
  browser (`e2e/ats-flow.cjs`) the recruiter emails a whole stage, moves two to Offer together and rejects one, and
  the board and histories agree after a reload.
- Employee 360: `employee360.spec.ts` (HR, payroll, manager, the employee, a colleague and another workspace); the
  directory browser flow checks the strip and the Activity tab.
- Payroll stepper: the payroll browser flow checks it from Inputs through Approval to done.
- CREW IQ: `iq.spec.ts` (headcount and leave scoped to the asker, overtime trend, recruitment summary, refusals,
  actions that change nothing, policy answers, validation) and `iq.spec.ts` in contracts (intent matching); in a
  browser (`e2e/iq-flow.cjs`) the recruiter asks for the recruitment summary, sees headcount limited to themselves,
  opens the prefilled Quick Bid and requisition form, and opens and closes IQ by keyboard.
- Universe lenses: `lenses.spec.ts` (skills set by HR and by the person, refusals, the network by scope, scenario
  baseline with and without costs, save, update, delete, refusals) and the recruitment flow test in
  `recruitment.spec.ts`; drawing maths in contracts `lenses.spec.ts`; in a browser (`e2e/universe-flow.cjs`) the
  globe turns and its table adds up, HR adds a skill on a profile and the network shows the holder, the flow chart
  and table agree, and a scenario is saved, reopened after a reload and deleted.
- Every earlier browser flow still passes, in CI order on one database.

## Not yet
- CREW IQ understands the listed kinds of question only; anything else gets suggestions. It does not keep a
  conversation history between visits, and it does not answer from documents other than help articles.
- The globe draws locations on a graticule, without coastlines.
- Skills have no catalogue management screen (names are added as people type them) and no import; skills are not
  yet used to suggest people for requisitions or bids.
- Scenarios change headcount only; they do not model timing (month by month), attrition or pay rises, and cannot
  be turned into requisitions.
- The recruitment flow counts a rejection or withdrawal at the stage the application was in when it closed; an
  application reopened later is counted where it is now.
