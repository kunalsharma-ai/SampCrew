# Phase 6 report: Performance, learning and engagement

Phase 6 adds goals, review cycles with 360 feedback and calibration, a learning catalogue, anonymous surveys and a recognition wall. They are grouped under **Talent** in the Web Portal and need the `talent` plan feature (Business plan).

Nothing in this phase uses AI. Every rating is written by a person, and every change to a final rating needs a recorded reason.

## What was delivered

### Goals and OKRs
- **A goal** belongs to one employee and covers a period. It has an optional weight and up to ten key results. Each key result has a start value, a target and a unit.
- **Progress** is worked out, not typed, whenever a goal has key results.
  - A key result's progress is the share of the way from its start to its target, kept between 0 and 100. It works for falling targets too, such as defects going from 40 to 10.
  - A goal's progress is the average of its key results.
  - With no key results, the owner reports a percentage at each check-in.
  - Overall progress on "My goals" is weighted by goal weight, or equal when no weights are set.
- **Check-ins** record new key result values, a confidence level (on track, at risk, off track) and a note. They are append-only. When a check-in is at risk or off track, the manager is notified.
- **Alignment:** a goal can support a goal of the owner's manager chain, up to five levels up. The goal page shows what it supports and what supports it.
- **Who sees what:** the owner, their managers and anyone with `performance:manage` in scope. Managers can set goals for their team.
- **History is kept.** A goal with check-ins or supporting goals cannot be deleted (409 `goal_in_use`). Cancel it with a reason instead.

### Review cycles
A cycle goes **Draft → Writing reviews → Calibration → Released**.

- **Draft:**
  - HR (`performance:configure`) sets the period, the audience (a legal entity and/or a department with its sub-departments), the questions, the rating scale (lowest first), due dates, and whether self reviews and 360 feedback are used.
  - The draft shows who it will include and who their reviewing manager is.
- **Launch** creates one review per person and snapshots their current manager as the reviewer. People without a manager are listed; HR writes their manager review. Everyone is notified.
- **Writing reviews:**
  - The employee writes a self review. The manager writes the manager review. Both can be saved as drafts and are locked once submitted.
  - Drafts are private to their author.
  - The manager sees the self review once it is submitted.
  - The employee does not see the manager review until results are released.
  - HR can reassign the reviewing manager, or leave a person out of the cycle with a reason (for example long leave).
- **360 feedback:**
  - The manager, or HR, asks colleagues for feedback. Each colleague answers two fixed questions ("What does this person do well?" and "What could they do more of, or differently?") or declines.
  - The manager and HR see who said what.
  - The employee sees peer feedback only after release, without names and in alphabetical order, and only when at least three colleagues answered. Below three, the employee is told it is withheld.
- **Calibration** can start only when every manager review is submitted (409 `manager_reviews_missing` otherwise). Unanswered feedback requests are withdrawn. Each final rating starts as the manager's rating. HR can change it with a reason of at least five characters, and every change is kept in the review's history. The cycle page shows the rating distribution.
- **Release** shows the results to everyone in the cycle and notifies them. The employee acknowledges, with an optional comment.
- **Released reviews and submitted feedback are frozen by database trigger,** so not even a direct database connection can change them. Updates of a released review are rejected with 409 `locked`.

### Learning
- **Catalogue:** HR (`learning:configure`) adds courses and learning paths.
  - A course is online, classroom, document or video. It has an optional `https` content link, a duration, a category and an optional validity in months.
  - A course can allow self-enrolment.
  - A path is an ordered list of courses.
- **Assigning:** managers and HR assign a course or a path to people in their `learning:manage` scope, with a due date. People who already have the course open are skipped, and the result says how many.
- **My learning:** people start courses and mark online ones complete. Classroom attendance is recorded by the manager, not the learner.
- **Validity:** a completion with a validity gets an expiry date. "Overdue" shows assignments past their due date.
- **Completed assignments are frozen by trigger.** Removing an assignment needs a reason.

### Surveys
- **Surveys are always anonymous.** There is no setting to turn that off.
- **Setup:** HR (`engagement:manage`) builds a survey from scale (1 to 5), eNPS (0 to 10) and free-text questions. HR sets the audience and an anonymity threshold between 3 and 50.
- **Opening** invites everyone in the audience. It fails with 400 `audience_too_small` if the audience is smaller than the threshold. Questions cannot change after opening.
- **Answers are stored without the person.**
  - The response row has no employee column. A trigger rejects any attempt to add a person link.
  - Only the department, the legal entity and the date are kept with the answers.
  - A separate invitation row records that someone has answered, with no time and no link to the answers, so people can answer only once.
  - Answering writes nothing to the audit trail.
- **Results:**
  - Results show only once at least the threshold number of people answered.
  - They include the average and distribution per scale question, eNPS (percentage answering 9 or 10, minus the percentage answering 0 to 6) and the comments in alphabetical order.
  - The department breakdown merges groups smaller than the threshold into "Other groups". If that merged group is still too small, so that a small group could be worked out, the breakdown is withheld.
  - Opening results is audited.

### Recognition
- **Posting:** anyone can recognise a colleague on the wall, optionally for a company value. Self-recognition is refused, and there is a limit of 20 posts a day per person.
- **Notification:** the person and their manager are notified.
- **Company values:** HR manages them. New workspaces start with Customer first, Ownership, Teamwork and Safety.
- **Moderation:** HR can hide a post with a reason, which is audited.

### Who can do what

| Permission | Default holders | Scope |
|---|---|---|
| `performance:read` | Everyone | Own goals and reviews, plus what each role's scope allows |
| `performance:manage` | Department managers, HR | Team, department, entity or workspace |
| `performance:configure` | HR admin | Workspace (cycles, calibration, release) |
| `learning:read` / `learning:manage` | Everyone / managers and HR | Own / scoped |
| `learning:configure` | HR admin | Workspace (catalogue) |
| `engagement:manage` | HR admin | Workspace (surveys, results, values, moderation) |
| `surveys:respond`, `recognition:give` | Everyone | Own |

Out-of-scope goals, reviews and feedback return 404.

### Web Portal screens
The new **Talent** navigation group contains:

- **Goals:** mine and my team. Includes a goal dialog with a key-result editor, and a goal page with check-ins and alignment.
- **Reviews:**
  - Tabs for mine, my team and feedback requests.
  - The review page covers self and manager forms, peer feedback requests, calibration, acknowledgement and leaving a person out.
  - A page for answering feedback.
- **Review cycles (HR):** a list and a draft dialog. The cycle page shows the preview, the progress of each stage, the rating distribution, and the launch, calibration and release actions.
- **Learning:** tabs for my learning, the catalogue (with self-enrol) and my team (with assign, record attendance and only overdue). **Course catalogue (HR)** manages courses and paths.
- **Surveys:** a list and an answer form. **Survey results (HR)** has the builder, open and close, and results with the breakdown.
- **Recognition:** the wall, a post form, and company values for HR.

## Demo data
Everything below is labelled as demo data.

- **Goals:** three aligned goals.
  - Plant head: raise line OEE to 85%, from 72% and now at 77%.
  - Supervisor: cut handover defects from 40 to 10, now 28 and at risk, with a check-in. This supports the OEE goal.
  - Operator Arjun: CNC certification, at 50%. This supports the defects goal.
- **Review cycle:** an active "Mid-year review (demo data)" for the Assembly line.
  - Most manager reviews are in.
  - Arjun's self and manager reviews are still open.
  - Arjun has three submitted peer feedbacks, so the full cycle can be tried end to end.
- **Learning:**
  - Courses: Forklift safety (renew every 12 months), Fire drill (classroom), and Lean basics and Spreadsheets (both self-enrol).
  - A "Shop floor safety" path is assigned to two operators. Neha has completed the forklift course.
- **Survey:** an open "Plant pulse (demo data)" for Manufacturing, threshold 3, with three demo answers.
- **Recognition:** three posts on the wall.

## Tests
- **Contracts:** 72 unit tests. `talent-math.spec.ts` adds 12, covering:
  - Key result progress, including falling targets.
  - Weighted goal progress.
  - The rating distribution.
  - eNPS.
  - Survey summaries.
  - Answer validation.
  - The breakdown rule that merges or withholds small groups.
- **API:** 172 integration tests across 13 files. `test/talent.spec.ts` adds 23, covering:
  - **Access:** the plan gate, and HR-only cycles, catalogue and surveys.
  - **Goals:** progress from check-ins. Visibility for the owner, managers and HR only. Team goals aligned with the manager's goals. Cancel rather than delete once history exists.
  - **The review cycle end to end:** preview and launch, self drafts locked on submit, 360 feedback, the calibration prerequisite and exclusion, calibration with reasons and results hidden until release, anonymous peer feedback above the threshold only, and the database freeze.
  - **Learning:** catalogue and paths, team-only assignment without duplicates, completion with expiry, manager-confirmed classroom attendance, self-enrolment and overdue.
  - **Surveys:**
    - Audiences below the threshold are refused.
    - Each person answers once, and no person link is stored.
    - eNPS of 25 for answers 9, 6, 10 and 7.
    - A breakdown withheld when one department has 3 answers and another has 1.
  - **Recognition:** the wall, notifications and moderation.
  - **Isolation:** of all 16 new tables, by database role and by API.
- **Browser:** `e2e/talent-flow.cjs` runs in a real browser and fails on any browser error.
  1. An operator adds an aligned goal with a key result and checks in.
  2. The operator submits their self review.
  3. The supervisor reads it and submits the manager review, which stays hidden from the operator.
  4. HR starts calibration, changes the final rating with a reason and releases.
  5. The operator reads the results and the nameless peer feedback, and acknowledges.
  6. The operator self-enrols in a course and completes it.
  7. The operator answers the pulse survey, and HR opens the results.
  8. The operator recognises a colleague.

  CI runs it after the payroll flow.

### Defects found and fixed during this phase
- HR and other viewers could read a manager's draft review before it was submitted. Only its author sees a draft now.
- A database rule that blocks a change surfaced as a 500 error. It now returns 409 `locked`.

## Security verification
- **Tables:**
  - All 16 new tables have forced Row-Level Security and composite workspace foreign keys.
  - Check-ins, calibration history and survey responses are insert-only for the API role.
  - Released reviews, submitted feedback and completed assignments are frozen by trigger.
- **Survey anonymity** is enforced in the database, not only in the API. Responses have no person column, a trigger refuses person links, invitations carry no time, the threshold is enforced at opening and in results, and answering is not audited.
- **Routes:** every new route declares its permission and the `talent` plan feature. The OpenAPI spec now has 349 operations.
- **Content links** on courses must be `https`, and they open in a new tab with `noopener`.

## Known limits
- **No AI** in this phase. There are no suggested goals, review summaries or sentiment analysis. Any later AI help will be explainable and need a person's approval, as with the rest of CREW.
- **Not built yet:** performance improvement plans, internal mobility and succession, continuous one-to-one notes, the HR helpdesk and announcements. The helpdesk moves to Phase 7.
- **No content hosting or SCORM/xAPI.** Courses link to content hosted elsewhere, and completion is reported by the learner or the manager.
- **Survey anonymity limits:** the department, legal entity and date stored with each answer can still narrow down who answered in a very small group. The threshold reduces this risk but cannot remove it. Free-text comments can identify someone by their content, and the answer form warns about this. Surveys have no scheduling, reminders or templates.
- **Review cycles:** one rating scale per cycle, with no goal-weighted score in the rating. There is no rating guidance per level, and the 360 feedback questions are fixed.
- **No reports or exports** for talent data yet.

## Next: Phase 7 (Mobile and HR helpdesk)
- A mobile app for self-service, punching and approvals.
- An HR helpdesk with cases and announcements.
