# Phase 4 report: Recruitment

Status: complete, pending product owner review.
Date: 2026-10-31.

## What was delivered

### Requisitions
- A hiring manager or recruiter raises a requisition: title, department, legal entity, location, hiring manager, employment type, work mode, openings, budget range, target start, justification, description and the interview scorecard.
- Requisitions are numbered per workspace (`REQ-0001`, `REQ-0002`, …).
- Submitting sends it through the approvals engine from Phase 2 (HR admin by default, falling back to the workspace owner; configurable like other approval types).
- Life cycle: draft, awaiting approval, approved, open, on hold, filled, closed, cancelled, not approved. Each move is checked on the server and audited.
- Once approved, the budget and the shape of the role are fixed. Wording, scorecard, start date and hiring manager can still change.
- A requisition closes itself as filled when the last opening is hired. Putting it on hold or closing it takes its posting off the career site.

### Career site
- Each workspace can switch on a public career site at `/careers/<address>`. The address is unique across CREW.
- It lists published postings of open requisitions only. A posting has its own public title, address, summary, description, shown location, and an option to show the budget range. Internal fields (justification, notes, hiring manager) are never sent to the public pages.
- The apply form takes name, email, phone, location, profile link, a cover note and a CV (PDF or Word `.docx`, up to 5 MB).
- Applicants must agree to the workspace's privacy notice. The notice is versioned: changing its text creates a new version, and each candidate record keeps the version they agreed to.
- The response is the same whether the person is new, already a candidate, or has already applied, so the form cannot be used to find out who applied. A hidden field catches simple bots and gets the same response with nothing stored.
- Applying is limited to 5 requests a minute per visitor. The applicant gets an acknowledgement email; the hiring manager and the recruiter who raised the job get a notification.
- A workspace whose plan does not include recruitment, or that is suspended, has no career site (404).

### Candidates and the pipeline
- Candidates come from the career site or are added by recruiters. Adding someone by hand requires confirming there is a lawful basis to hold their details (for example, they sent a CV). The candidate record shows which basis applies.
- One candidate can apply to several jobs; each is a separate application with its own stage and history.
- Pipeline stages are set per workspace. New workspaces get Applied, Screening, Interview, Offer and Hired. Recruiters can add, rename, reorder and remove stages. Applied stays first and Hired stays last.
- The job page has a board with a column per stage. Moving a card is a single choice; nobody can move a candidate straight to Hired.
- Rejecting needs a reason from a fixed list and an optional internal note. It can queue a short, neutral email to the candidate that never includes the reason or note. Rejecting also cancels future interviews and withdraws open offers, including any waiting for approval.
- Withdrawn and rejected applications can be reopened while the job is still taking candidates.
- Every application has an append-only history (applied, moved, interviewed, scorecard in, offer steps, emails queued, hired). The history holds no free text, so it can be kept after a candidate is erased.
- Notes on a candidate are internal and are never shown to the candidate.
- CVs are checked by content, not just by name, before they are stored. They are downloaded through short-lived signed links, and every download is audited.

### Interviews and scorecards
- Recruiters schedule an interview with a title, time, length, format (video, in person or phone) and a panel of interviewers. A video interview needs the meeting link, which the organiser creates in their own tool. CREW does not create meetings.
- The panel gets a notification and an email. The candidate can be emailed the time, in the job location's time zone, and the joining details.
- Interviewers see "My interviews", the candidate's CV and the role description, without needing wider access to candidates.
- Each interviewer submits one scorecard: a 1 to 4 rating for every criterion on the requisition's scorecard, evidence notes, a recommendation and a summary. The scorecard opens when the interview starts and cannot be changed after it is submitted.
- Interviewers do not see each other's scorecards until they have submitted their own, so first impressions stay independent. People who manage the pipeline see all of them, and the board shows the average score and how many scorecards are in.

### Offers and hiring
- A recruiter drafts an offer: job title, designation, base pay, currency, pay period, variable pay, joining date and reply-by date. Drafting moves the candidate to the Offer stage.
- An offer above the requisition's approved budget is flagged, and the approval summary says so.
- Offers go through the approvals engine (HR admin by default). Approving an offer requires a two-step verified session.
- After approval, the recruiter sends it: the terms are emailed to the candidate. The recruiter then records the candidate's answer (accepted or declined) with a note.
- Hiring is done by someone who may create employees, usually HR. It creates the Core HR employee record from the accepted offer and the requisition (legal entity, department, location, designation, manager), starts onboarding as in Phase 2, marks the application hired, and counts the hire against the requisition. All of this happens in one transaction, re-checked under lock so two people cannot fill the last opening at once.

### Candidate data: erasure and retention
- Recruiters with workspace-wide access can erase a candidate on request. Names and contact details are removed, files are deleted, notes are deleted, and the text of scorecards is removed. The anonymous pipeline history stays for reporting. The erasure and its reason are audited.
- Each career site sets how long candidate data is kept (30 to 1,825 days, 365 by default), counted from the candidate's last activity. The hourly background job erases candidates past that period who have no application in process and no live offer.

### Who can do what
| Role | Requisitions | Candidates | Offers | Settings |
|---|---|---|---|---|
| Recruiter | Raise and manage, all | See and manage, all | Draft, send, record answers | Stages and career site |
| Hiring manager | Raise for their department; see their department's | See their department's; manage their own requisitions' | No | No |
| HR admin | See all; approve | See all | Approve (two-step verified) | Stages and career site |
| HR (employees:create) | | | | Completes the hire |
| Any employee on a panel | | Their interviews only | | |

### Web Portal screens
- **Jobs:** requisitions with status filters and "only mine", and a form for new requisitions.
- **Job page:** requisition details and actions, the posting editor with publish and unpublish, and the pipeline board with add candidate and a rejected view.
- **Candidates:** search and add.
- **Candidate page:** each application with stage moves, interviews, offers and hire; notes; history; details and consent basis; CV upload and download; erasure.
- **My interviews** and the **interview page** with the scorecard form and other scorecards once yours is in.
- **Recruitment settings:** pipeline stages and the career site.
- **Public career site** (`/careers/<address>`) and job pages with the apply form, outside the signed-in app and usable on a phone.

## Demo data
The demo workspace now also has:
- A live career site at `/careers/northwind-demo`.
- An open requisition, Quality Engineer (`REQ-0001`), with a published posting and three candidates at Applied, Screening and Interview. The interview took place yesterday and the QA lead's scorecard is still due, so the scorecard flow can be tried straight away.
- A draft requisition, CNC Machine Operator (`REQ-0002`), raised by the plant head, ready to submit for approval.

All demo candidates are tagged "demo", their source is "Demo data", and their email addresses are on a `.local` domain, so nobody real is contacted.

## Tests

| Suite | Count | Covers |
|---|---|---|
| Contracts unit tests | 46 | As before |
| API integration tests | 133 | Earlier tests plus 23 recruitment tests |
| Recruitment browser test (`e2e/recruitment-flow.cjs`) | 1 flow | A visitor applies on the career site with a CV and consent; the recruiter finds the application, moves it and downloads the CV; the QA lead submits a scorecard; the recruiter drafts an offer and submits it; HR turns on two-step verification and approves it; the recruiter sends it and records the acceptance; HR hires and lands on the new employee record; the plant head submits a requisition and HR approves it; the recruiter adds a stage; every screen opens and settings are closed to a hiring manager |
| Web Portal, Core HR, attendance and console browser tests | 4 flows | As before, still passing |

The recruitment integration tests cover:
- Requisition approval, numbering, fixed budget after approval, and the audit trail.
- Scope: hiring managers see their department only, recruiters see all, employees none; a hiring manager cannot raise for another department.
- The plan gate (402 without recruitment).
- Career site settings, unique addresses across workspaces, the privacy notice version.
- Public pages: only published postings of open jobs, nothing internal exposed, 404 for unknown or switched-off sites and for jobs on hold.
- Public apply: consent required, CV required and checked by content, the same response for repeat applications and for the bot trap, the acknowledgement email and notifications.
- Manual candidates need a lawful basis; duplicates are refused.
- The pipeline board, stage moves, no direct move to Hired, and the history being append-only even for the app's database role.
- Signed CV links: work for people in scope and for panelists, refuse tampered signatures and document-style links.
- Interviews: link required for video, invitations with the meeting link and time zone, panel access to the CV without candidate access.
- Scorecards: criteria must match, panel members only, once only, not before the start, hidden from other interviewers until they submit, all visible to the hiring manager, and the average on the board.
- Rejection: reason, internal note kept out of the candidate email, future interviews cancelled, reopening.
- Offers: drafting, above-budget flag, approval needing two-step verification, sending, recording the answer, no hire before acceptance.
- Hiring: only people who may create employees, the employee record and requisition filled, the posting taken down, no second hire.
- A pending offer approval cancelled when the application is rejected.
- Erasure (and that a hiring manager cannot erase) and retention.
- Stage settings.
- Workspace isolation for every Phase 4 table.

CI now also runs the recruitment browser flow.

### Defects found and fixed during this phase
- **Uploads over 1 MB failed in the Web Portal** (a Phase 2 defect). Next.js limits server-action request bodies to 1 MB by default, so employee documents over 1 MB were refused although the screen allows 10 MB, and most CVs would have been too. The limit is now 11 MB; the API still enforces the real per-file limits.
- **Rate limits were shared by every visitor.** The Web Portal calls the API from the server, so the API saw one address for everyone and the per-address limits (sign-in, and now applying) applied to all users together. The Web Portal now forwards the visitor's address, taken from the proxy in front of it.
- Rejecting or withdrawing an application left an offer that was waiting for approval still waiting, so approvers would have been asked to approve an offer for someone no longer in the process. Its approval is now cancelled.
- The public application's audit entry had no workspace, which made every application fail. Found by the integration tests.
- The bot trap field was validated as empty, so a bot filling it got a validation error that revealed the trap. It now gets the normal response.
- Money in approval summaries was formatted through floating point and with Western digit grouping for rupees, and the above-budget check compared floating-point numbers. Both now use exact decimals (the check runs in PostgreSQL), and INR uses Indian grouping.
- The approval link for an offer opened the recruitment home page. It now opens the candidate.

## Security verification
- Every new table has forced Row-Level Security and composite workspace foreign keys, checked by the isolation test. The application history is insert-only for the API login and refuses updates and deletes by trigger.
- Every new signed-in route declares its permission and the `recruitment` plan feature; the OpenAPI spec now has 244 operations.
- The public career site needs no sign-in by design. It finds the workspace from the site address, checks the site is on, the workspace is active and the plan includes recruitment, and then works inside that workspace's Row-Level Security context. It returns only public posting fields.
- Public applying is rate limited, size limited (5 MB, one file, limited fields), checks the CV's content against its declared type, and accepts only PDF and `.docx`.
- The apply response does not reveal whether someone already applied or is already a candidate.
- CV links are HMAC-signed, expire after 5 minutes, and are signed for CVs specifically, so a document link cannot be reused to fetch a CV or the reverse. Downloads are audited.
- Offer approval requires a two-step verified session. Hiring requires `employees:create` for the legal entity.
- Out-of-scope requisitions, candidates and interviews return 404.
- Candidate emails use a footer that says why they received the email.

## Known limits
- **No candidate portal.** Candidates cannot log in, see their status or accept an offer online. The recruiter records the answer the candidate gives by email or phone. There is no e-signature.
- **No calendar or video integration.** CREW does not create meetings or calendar invites; the organiser adds the meeting link. Interviewers are not checked for clashes.
- **No AI screening or ranking yet.** That is planned with the AI phase, as recommendations a person approves, with the reasons shown.
- **No job-board syndication** and no agency portal. Postings appear on the CREW career site only.
- **No offer letter documents.** The offer email carries the terms; generating a signed PDF letter is not built.
- **No virus scanning** of CVs. Files are checked by type and size only.
- **Career site look.** Headline and introduction only; no custom domain, logo or colours yet.
- **Rate limits** are kept in memory per API instance (as in earlier phases) and rely on the proxy in front of the Web Portal setting `X-Forwarded-For`.
- **The recruitment browser test needs a fresh database,** because it turns on two-step verification for the demo HR admin.

## Next: Phase 5 (Payroll and finance)
- Salary structures and components.
- India payroll with statutory deductions.
- Payslips.
- Expenses and reimbursements.
