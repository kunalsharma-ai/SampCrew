# Design refresh, part 5: finishing the open items

Source: "CREW front end design" (see [design-1.md](design-1.md)). Part 4 ([design-4.md](design-4.md)) listed what was
not yet built; this part builds it: CREW IQ conversations and more subjects, coastlines on the globe, scenarios that
unfold over time and turn into requisitions, and a managed skill list that jobs use to find people.

## What was built

### CREW IQ: conversations and follow-ups (migration 0016, `/iq/conversations`)
- Every question and answer is kept in a conversation that belongs to the person who asked. The panel lists past
  conversations; one can be reopened, deleted, or all deleted. Nobody else can open them (another person gets 404).
- Short follow-ups are read against the previous question: "How many people work here?" then "What about Talent
  Acquisition?" answers the headcount for that department, and says it was read as a follow-up. "Everyone" drops
  the department again. Department names are recognised in any question about headcount, leave or overtime.
- Nine more subjects, each from records and under the asker's own access: the latest payroll runs with net pay and
  the change (payroll access, per legal entity), expense claims waiting for the asker, leavers and attrition over a
  period, people on probation and when it ends, work anniversaries this month, who is absent today, goals at risk,
  overdue learning, and open requests (the asker's own, or the queue for people who handle them).

### Coastlines on the locations globe
The globe draws land from Natural Earth (world-atlas 110m, loaded only when the Locations lens opens) with d3-geo's
orthographic projection, so offices sit on real coastlines and the outline turns with the globe.

### Scenarios over time (migration 0017)
- Each change can carry the month it happens and the role added. A scenario has a first month, a horizon (6 to 36
  months), yearly attrition (leavers are not replaced; people who join leave at the same rate from when they join)
  and a pay rise from a chosen month.
- A chart and a month-by-month table show planned headcount, expected headcount after leavers and the no-change
  baseline, with monthly cost when the viewer's payroll access covers everyone counted. Totals give the expected
  headcount at the end, the leavers to replace to hold the plan, the cost over the horizon and the difference
  against no changes. The maths (`projectScenario`) lives in `@crew/contracts` and is shared by the page and tests.
- "Raise draft requisitions" (`POST /insights/scenarios/:id/requisitions`) creates one draft per department the plan
  adds people to: the role as title, the people as headcount, the change month as the target start, the department
  head (or the person raising) as hiring manager. It needs planning access and `requisitions:create` for every
  department, checked before any draft is made. Drafts link back to the scenario, are never raised twice, are
  audited, and go through the normal approval.

### Skill list and matching (migration 0018)
- A Skill list under the Skills lens: add, rename (a clash with an existing name asks for a merge), set a category,
  merge one skill into another (holders and jobs move over at the higher level) and remove. For people who may
  update every employee record; everyone else sees the list with holder counts limited to people they can see.
- Jobs name the skills they need and the lowest level that counts ("Skills for this job" on the job page). People
  already in the workspace who hold them are ranked by match (`matchScore`: full credit at or above the level, half
  credit scaled below it), showing which skills they meet. Only people the viewer can see are listed.

## Working end to end
- CREW IQ: `iq.spec.ts` (API: the nine subjects, payroll refused to HR without payroll access, department narrowing,
  follow-ups, conversations listed, reopened, kept private and deleted) and contracts `iq.spec.ts` (matching and
  follow-ups); in a browser (`e2e/iq-flow.cjs`) the recruiter asks a follow-up about a department, starts a new
  conversation, reopens the earlier one from Past conversations and deletes one.
- Globe: the universe browser flow checks that coastlines are drawn.
- Scenarios: contracts `lenses.spec.ts` (month-by-month plan, cost with a pay rise, attrition, changes after the
  horizon, input checks); `lenses.spec.ts` in the API (assumptions saved, drafts raised once with role, headcount and
  start month, refused without `requisitions:create`, audited); in a browser HR plans Finance +2 from a month with
  10% attrition over 18 months, checks the chart and table, saves and reopens it, and the plant head raises two draft
  requisitions from the demo scenario, cannot raise them twice, and opens one.
- Skills: contracts tests for `matchScore` and input; API tests for the list (counts by scope, rename, clash, merge
  keeping the higher level, remove, refusals, audit) and for job skills (ranking, unknown skills, other workspaces,
  removal); in a browser HR adds Welding, merges Robot welding into it and files it under Shop floor, and the plant
  head names two skills on the new job and sees people here ranked best first, kept after a reload.
- `pnpm test` (contracts 201, API 301, mobile 15) and every browser flow, in CI order on one database.

## Not yet
- CREW IQ answers the listed subjects only (now sixteen kinds of question and follow-ups); anything else gets
  suggestions. It does not read uploaded documents other than help articles.
- Skills cannot be imported in bulk, and bids do not yet suggest people by skill (jobs do).
- Scenarios model attrition evenly across months and the same rate for every department.
- From the wider design document, still open: one-off fees and rate cards on bids, saved candidate views in the ATS,
  offer amounts in candidate comparison, theming in the mobile app and Excel export of reports.
