# Phase 29 report: Learning & Development (LMS)

Kunal asked (part 4 of the 20 November 2026 brief) for a full Learning & Development module: learning modules built
from mixed content, quizzes and assignments, targeted assignment, Super Workspace control over what each HR
Workspace may do, a learner's "My learning" with a step-by-step player, certificates, versioning, dashboards, reports
with Excel export, and security at every layer. The old Learning page (courses and assignments) is replaced; its
API (`/learning/courses`, `/learning/assignments`) still works for the phone app.

Migration: `0070_learning_modules` (new collections for modules, versions, audiences, enrolments, quiz attempts,
submissions, learning permissions and custom categories; existing courses become published version-1 modules with
one content item, and existing assignments become enrolments on that version).

## Working end to end, and not yet

### Working end to end
Each item runs against the real API and MongoDB, is covered by `apps/api/test/learning-lms.spec.ts` (12 tests),
`packages/contracts/src/learning.spec.ts` (grading, progress, due states, embeds, legacy conversion), and by the
browser flow `e2e/learning-flow.cjs` (`pnpm e2e:learning`, new CI step on a fresh database). It ran green on
21 November 2026 with no browser errors, as did `e2e:web`, `e2e:talent`, `e2e:neon`, `e2e:help` and `e2e:a11y`.

- **Creating a module** (Learning management, New module): a three-step wizard (Details, Content, Settings).
  Title, short and full description, category (standard list plus custom categories), topic, skills, difficulty
  (or a custom level), duration, language, tags, cover image, creator name and designation, self-enrolment,
  certificate, default due days.
- **Content builder**: text (sanitised HTML), video upload or YouTube/Vimeo link, audio, PDF or document, image,
  external link, classroom session, quiz and assignment. Items can be reordered, duplicated, removed and marked
  required or optional. Uploads go to private storage (50 MB limit, virus scan when ClamAV is configured).
- **Video completion rules**: watch a minimum percentage (seeking past the furthest watched point is blocked and
  watched time comes from server heartbeats), mark complete by hand, or complete on open.
- **Quizzes**: eight question types (multiple choice with one answer, multiple select, true/false, typed single
  answer, short answer, long answer, matching, scenario). Pass mark, attempts, time limit with a countdown, shuffling of questions and
  options, autosave, retakes, score and correct answers shown after submitting if the creator allows it, final
  assessment. Short and long answers go to a reviewer. Correct answers never reach the learner's browser before submitting.
- **Assignments**: instructions, text, link and file answers, due date, marks and pass mark. Reviewers approve,
  reject or ask for a resubmission with feedback; the learner resubmits and sees the outcome.
- **Publishing and versions**: draft, scheduled (goes live on a date), published, archived. Each publish creates a
  new version with a note; people who completed an earlier version keep that version and its certificate, and see
  "Updated since you finished".
- **Assigning**: everyone, HR Workspaces, departments, job roles, locations or named people, with a due date and
  "keep enrolling new joiners who match". Audiences can be stopped and individual enrolments removed.
- **Who can do what**: the Super Workspace sees and manages everything and turns each capability on or off per HR
  Workspace (view, create, edit, publish, assign, quizzes, assignments, grading, reports, export). HR Workspaces start view-only and only ever
  see and assign their own people. The rules are enforced in the API and in every database query, not only in the
  screens; the flow checks that an HR Workspace's report holds exactly its own people.
- **My learning**: assigned learning with status (not started, in progress, completed, overdue), due dates,
  progress, scores, search, category filter, and a learning library for self-enrolment. The player walks through
  each item and completes the module when every required item is done. Certificates can be printed.
- **Dashboards and reports**: modules, learners, completion rate, overdue and reviews waiting; a status donut;
  completion by module; tables by HR Workspace, department and job role; quiz results; recent completions; overdue
  list. Reports filter by module, HR Workspace, department, job role, status, dates, score and name, open a learner's history or a single
  enrolment, and export to Excel.

### Not yet
- Watch time for YouTube and Vimeo links is not tracked; those videos use manual or on-open completion.
- Native phone screens for the new module are not built; the web pages are responsive and the existing phone
  Learning screen keeps working through the old endpoints.
- Uploads are capped at 50 MB; with ClamAV on, its own stream limit (25 MB by default) applies first.
- The workspace overview still counts draft modules until the dashboards work changes that tile.

## Gotchas for the next person
- Values exported from a `'use client'` file are not readable from a server page (`MY_TABS` lives in `types.ts`).
- `Input` and `Select` have a built-in `w-full`, and `cn` does not merge classes: size them with `max-w-*`.
- Playwright's Chromium cannot play H.264, so the e2e video fixture is WebM (`e2e/fixtures/safety-intro.webm`).
- Upload bodies pass through middleware: `experimental.middlewareClientMaxBodySize` is `52mb` in `next.config.ts`.
- After any API change, regenerate `docs/api/openapi.json` (`node dist/openapi-export.js` in `apps/api`).
