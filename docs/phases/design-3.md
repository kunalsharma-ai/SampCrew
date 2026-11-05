# Design refresh, part 3: staffing bids, Workforce Universe and the ATS board

Source: "CREW front end design" (see [design-1.md](design-1.md)), sections on the staffing bid module, the
3D / 4D workforce intelligence module ("CREW Workforce Universe") and the ATS views. Part 2 is in
[design-2.md](design-2.md).

## What was built

### Staffing bids (`/staffing/bids`, migration 0013, `apps/api/src/modules/bids`)
A staffing company prices a team for a client, has Finance approve the price, sends the proposal PDF and records
whether it won. Gated by the recruitment feature; permissions `bids:read`, `bids:manage`, `bids:approve`
(recruiters manage, Finance and HR approve, everyone with access reads; scoped own, entity or tenant).

- **Clients** (`/staffing/clients`): name, legal name, contact, email, phone, industry, currency, address, notes;
  bids and wins per client; archive keeps the history. A client can also be added from inside a bid.
- **Proposal templates** (`/staffing/templates`): cover note, terms, validity in days and pricing defaults
  (on-costs %, overhead %, target margin %). One default; a "Standard proposal" is created on first use.
- **Quick Bid** (`/staffing/bids/new?mode=quick`): client, one role, people, location, monthly pay and term. The
  rest comes from the default template; the title fills itself in ("10 Warehouse associates for Northwind").
- **Advanced Bid**: several roles, a bill rate per role (or derived from the target margin), designation per role,
  the bidding entity, currency, pricing assumptions, cover note, terms and validity.
- **Pricing** (`priceBid` in `@crew/contracts`, exact integer maths shared by browser and server): loaded cost =
  pay plus on-costs plus overhead; a derived bill rate = loaded cost / (1 - target margin), rounded up to a whole
  unit so the margin is never under target; margin and markup per role and in total, monthly and for the contract.
  The editor shows it live; below-target and loss-making bids are flagged.
- **Approval**: "Save and submit" snapshots the bid as a version and starts an approval (Finance by default,
  changeable in approval policies, type `staffing_bid`). The approver sees the margin against target in the
  request and can approve or send back with a comment from the bid page or the Approvals inbox. A bid cannot be
  sent until approved; changing an approved or sent bid makes a new version that needs approval again.
- **Proposal PDF** (`/staffing-pdf/:id`): roles, locations, people, rate per person, monthly total, term,
  contract value, cover note and terms. Never costs or margins. Previewed on the bid page; each sent version's PDF
  is stored once and kept, so the history shows exactly what the client received.
- **Send now or schedule**: to the client contact (filled in), up to 5 cc, subject and message, now or at a set
  time up to 90 days ahead. The PDF is attached. A scheduled email can be cancelled until it goes; delivery status
  is shown per email.
- **Outcome**: mark a sent bid won or lost with a note, or withdraw any open bid (cancels a waiting approval and
  scheduled emails). The list shows the open pipeline value, bids waiting for approval, value won and win rate.

### Workforce Universe (`/insights/universe`, `GET /insights/universe`)
- **3D organization map** (three.js, loaded only on this page and only when the 3D view is shown): departments
  are glowing cores sized by headcount, sub-departments sit below their parent, people orbit their department,
  amber lines join departments with reporting across them, and optional lines show every reporting relationship.
  Drag to orbit, scroll to zoom, hover a person for their name and role, click a department to focus it.
- **Time-aware ("4D")**: a slider with a stop for every month end since the first joiner, and Play. The map is
  rebuilt from employment records for that date, so people appear when they join, glide to their new department
  when they transfer, and fade when they leave. The "Recent changes" panel lists joiners, leavers, moves,
  promotions and manager changes up to that date, highlighting the current step.
- **Accessible 2D table**, the default when the browser cannot draw 3D or the person prefers reduced motion:
  departments with headcount, change since the previous step and share, cross-department reporting in words, and
  the selected department's people with links to their profiles. The date, view and department are kept in the
  address, so a view can be shared.
- **Real data, scoped like the directory**: HR sees everyone, a department manager their department, a team
  manager their team. An employee whose access covers only their own record does not see the menu item.
- The demo workspace now has one transfer (Rekha Jadhav, Quality Assurance to Assembly Line, 1 April 2024), so the
  timeline shows a move.

### ATS board and candidate comparison (`/recruitment/jobs/:id`, `/recruitment/jobs/:id/compare`)
- **Drag and drop** a candidate card to another stage (never straight to Hired, which still needs an accepted
  offer); the "Move to" menu stays as the keyboard way to do the same. Each card shows days in its stage, amber
  after two weeks.
- **Compare**: tick 2 to 4 candidates and compare them side by side: current role, source, stage, days in stage
  and in process, average score, the average for every criterion on the job's scorecard (with how many ratings),
  recommendations (strong yes to strong no), interviews scheduled and offer status. The leader in each row is
  highlighted, and a candidate can be moved to another stage from the comparison
  (`GET /recruitment/requisitions/:id/compare?applications=a,b`).

## Working end to end
- Pricing maths, including derived rates, target and loss flags and rounding (contracts tests `staffing.spec.ts`).
- Clients, templates, quick-bid pricing equal to `priceBid`, codes, scoping across people and workspaces, submit
  and lock, Finance approval with the margin in the summary, the PDF, a scheduled email cancelled, an email sent
  through a real SMTP test server with the PDF attached, version 2 after editing a sent bid with version 1's PDF
  kept, won, lost and withdrawn, deleting a never-submitted draft, and the audit trail (API tests `bids.spec.ts`).
- In a browser (`e2e/bids-flow.cjs`): the recruiter adds a client and makes a Quick Bid (live price checked to the
  rupee), submits it; the PDF is served; Finance approves on the bid page; the recruiter schedules the email for
  tomorrow, cancels it, sends now with a cc, sees version 1 and its PDF in the history, marks it won, and the list
  shows it won with a 100% win rate after a reload.
- Universe model: who is present on a date, placement on any date, changes between dates, cross-department links
  and month stops (contracts tests `universe.spec.ts`); the API returns placement history with exact record
  ranges and is scoped for HR, a department manager, an employee and another workspace (`universe.spec.ts`).
- In a browser (`e2e/universe-flow.cjs`): department headcounts add up to the total; January 2024 has Rekha Jadhav
  in Quality Assurance, three months later she is on the Assembly Line with Quality's count one lower and the move
  in the change list; the 3D map draws with WebGL (software rendering in CI) and its code is a separate download
  fetched when the 3D view opens; Play moves the timeline.
- Comparison scores per criterion, recommendations, refusals for one candidate, a candidate from another job,
  people outside the job's scope and employees (API test in `recruitment.spec.ts`).
- In a browser (`e2e/ats-flow.cjs`): the recruiter drags a candidate from Applied to Screening and it is still
  there after a reload; compares two candidates across the job's scorecard; moves one to Interview from the
  comparison and the board agrees.
- Every earlier browser flow still passes.

## Not yet
- Staffing bids: client-side e-signature or acceptance link, bid line items for one-off fees, rate cards per
  client, currency conversion between bids in different currencies (totals are kept per currency), and turning a
  won bid into requisitions automatically.
- Proposal PDFs use the built-in Helvetica font, which covers Western European characters only; names in other
  scripts print with replacement characters. Embedding a Unicode font is next.
- Scheduled proposal emails go out with the normal mail queue, which runs every minute; there is no reminder if a
  scheduled email fails after retries beyond the "Failed" status on the bid.
- Workforce Universe: the distribution globe (needs coordinates on locations), recruitment flow, skills network and
  planning scenarios from the design document are not built. The 3D map draws one object per person, which is
  comfortable up to a few thousand people; very large workspaces will need instanced drawing.
- The 3D labels are not keyboard focusable; keyboard and screen-reader users use the 2D table, which has
  everything the map shows.
- ATS: no bulk move or bulk reject, no saved candidate views, and comparison does not include offer amounts.
