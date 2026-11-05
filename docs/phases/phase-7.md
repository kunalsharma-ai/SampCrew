# Phase 7 report: Mobile app and HR helpdesk

Phase 7 adds three things:

- An **HR helpdesk**: people ask HR questions as numbered cases, HR works them against response targets, and help articles answer common questions first.
- **Announcements** with an audience, read receipts and acknowledgements.
- The first **CREW mobile app** (Expo, for iOS and Android) for employees and managers, with an offline punch queue.

Everything here needs the `self_service` plan feature, which every plan includes. Punching from the app also needs `attendance_basic`.

Nothing in this phase uses AI.

## Working end to end, and not yet

This section says plainly what has been run end to end and what has not.

### Working end to end
Each item below runs against the real API and PostgreSQL. Each is covered by automated tests, and by a browser flow where it has screens.

- **Helpdesk in the Web Portal:**
  - Asking a question, with help-article suggestions.
  - The HR queue with response targets.
  - Internal notes, asking the employee for more information, priority and category changes, and assignment.
  - Resolving, rating and closing a case.
  - Confidential categories.
  - Category, handler and article settings.
  - Covered by `e2e/helpdesk-flow.cjs`.
- **Announcements in the Web Portal:**
  - Draft, audience, publish and notify.
  - Read receipts and acknowledgements.
  - The Home widget.
  - Covered by `e2e/helpdesk-flow.cjs`.
- **The mobile app's screens and logic.** These run in a browser build of the app (`e2e/mobile-flow.cjs`) against the live API:
  - Sign-in, including two-step sign-in with an authenticator code.
  - Punching in, then punching out with the network switched off. The punch is kept on the phone and sent when the network is back, with its original time and an "offline" flag.
  - Applying for leave, and a manager approving it from the app.
  - Asking HR and the full conversation with HR.
  - Reading and acknowledging an announcement.
  - Opening a payslip.
  - Signing the phone out. The server then refuses its old session.
- **Server side of the mobile app:**
  - Device registration.
  - Offline punch sync, with duplicate protection and clock and location checks.
  - Device sign-out.
  - The push queue. Delivery to a stub push server is tested; real delivery is not (see below).
  - Covered by API integration tests.

### Not yet working, or not yet verified
- **Not tested on real phones or simulators.** This environment cannot run Android or iOS simulators. The native build shares every screen and all app logic with the browser build that was tested. These parts are native only, so they have not been run:
  - Keychain/Keystore storage.
  - Fingerprint and face unlock.
  - Real GPS.
  - Push notifications.
  - Blocking screenshots on payslips.
  - Opening a screen from a notification tap.
- **Push is off until you set it up.** Push needs an Expo project (`EAS_PROJECT_ID` in the app build) and `EXPO_PUSH_ENABLED=true` on the API. Until then, notifications are queued and marked "skipped", with the reason. They still appear in the app.
- **Not published to the stores.** Store builds and submission (EAS Build, Apple and Google accounts) are not set up.
- **Not built yet:**
  - Recruiter, HR and payroll screens on mobile. These stay in the Web Portal.
  - Background or automatic geofence punching, QR scanning in the app, and selfie checks.
  - Attachments on helpdesk cases.
  - Email-to-case.
  - An HR chat assistant.
- **Response targets use calendar hours,** not working hours or holidays.
- **The browser build of the app** keeps its sign-in in the browser's local storage. It is labelled as a preview on its sign-in screen. Use the phone apps for everyday use.

## What was delivered

### HR helpdesk
- **Categories:** a workspace starts with five:
  - Pay and payslips
  - Leave and attendance
  - Documents and letters
  - IT and access
  - Something else

  Each category has a first-reply target and a resolution target in hours, and optional named handlers. HR (`helpdesk:configure`) adds, edits and archives categories.
- **Raising a case:**
  - An employee (`helpdesk:use`) chooses a category, writes a subject and question, and sets the urgency.
  - While they type, published help articles for that category are suggested.
  - Cases are numbered per workspace (HR-0001, HR-0002 and so on).
  - HR can also log a case on someone's behalf, for a question that came by phone or in person.
- **Assignment:** a new case goes to the category's handler with the fewest open cases. Without handlers, anyone who can handle cases for that person sees it in the queue.
- **Response targets:**
  - Targets are scaled by priority: low ×2, normal ×1, high ×0.75, urgent ×0.5.
  - Each target shows as on time, due soon (the last fifth, at least an hour), overdue, met or missed.
  - Changing the priority recalculates the targets.
- **Working a case:**

  | Who | Moves |
  |---|---|
  | Handlers | open → in progress / waiting on employee / resolved; in progress ↔ waiting on employee; any of these → resolved; resolved → in progress |
  | The employee | resolved → closed (confirm), or reopen |

  - Resolving needs a written answer.
  - HR's first public reply starts the clock as answered, moves an open case to in progress, and assigns the replier if nobody has it.
  - When the employee replies to a case waiting on them, it goes back to in progress.
  - Handlers can add internal notes, which the employee never sees.
  - The employee rates a resolved case once, from 1 to 5.
  - Resolved cases close by themselves after 7 days (hourly HR job).
  - A closed case is final, enforced by a database trigger.
- **Who sees a case:**
  - The person it is about.
  - Its handlers, and HR in scope (`helpdesk:manage` at entity or workspace scope).
  - **Managers never see cases.**
  - **Confidential categories** (for example a grievance) are seen only by their named handlers and the person. Every view by a handler is audited. Moving a case into a confidential category makes it confidential.
  - Anyone else gets 404.
- **Case text is never written to the audit trail.** Only the reference, category and status changes are.

### Announcements
- **Writing:** HR (`announcements:manage`) writes a draft. The audience is a legal entity, a department (with its sub-departments) and/or a location; leave all three empty for everyone. Options are "ask people to acknowledge", pin, and an expiry date.
- **Publishing** notifies the audience. After publishing, the title, text and audience are frozen by a database trigger, so only pinning and expiry can change.
- **Reading:**
  - Opening an announcement records a read receipt.
  - Acknowledgements are recorded once and cannot change.
  - HR sees, for each announcement, who in the audience has read and acknowledged it.
- **Archiving and deleting:** archiving takes an announcement off the feed and keeps the receipts. Drafts can be deleted.

### Mobile app (`apps/mobile`)
Built with Expo SDK 57, React Native 0.86 and Expo Router. The direct dependencies are pinned to versions published at least two weeks earlier.

- **Sign-in:**
  - Email and password, then the 6-digit code when two-step sign-in is on, then a workspace picker when the account has several.
  - Tokens go to the Keychain or Keystore (`expo-secure-store`).
  - Requests are marked as coming from the mobile app, so its sessions show as mobile.
- **Fingerprint or face unlock** is optional and asks for the biometric once to turn it on. When it is on, the app asks for it on start and after 5 minutes in the background. No biometric data leaves the phone.
- **Home:**
  - Today's shift and a punch shortcut.
  - Approvals waiting for you.
  - Announcements, marked "New" or "Please acknowledge".
  - Notifications.
  - The demo workspace label.
- **Attendance:**
  - Punch in and out with the phone's location, if allowed.
  - Today's punches, with the checks the server recorded on them.
  - The offline queue (see below), and punches the server refused, with the reason.
- **Leave:** balances, my requests with cancel, and a request form that previews working days and the balance after the request.
- **Ask HR:** my cases, a new question with article suggestions, and the case conversation with reply, confirm, reopen and rating. HR handlers who open a case get the handler moves too.
- **Me:**
  - Payslips. Amounts are formatted from exact decimal strings, and the payslip screen asks the operating system to block screenshots.
  - Two-step sign-in status.
  - Biometric unlock and push switches.
  - Signed-in devices, with remote sign-out.
  - Sign out.
- **Approvals** for managers: leave, corrections, overtime, expenses and the rest, with an optional comment.
- **Announcement** screen with acknowledge. **Notifications** list.

### Offline punches
1. **Saved on the phone first.** Each punch is written to the phone's storage before it is sent, with:
   - a per-device sequence number;
   - the phone's clock;
   - the app's monotonic clock and a run id;
   - the location, accuracy and "mock location" signal.
2. **Kept until the server answers.** Punches are sent in batches of up to 50 when the app comes to the foreground, every minute while some are waiting, and on "Send now". They stay queued until the server answers for each one. On a network error, timeout, 401, 404, 408, 429 or 5xx they are kept and marked as offline.
3. **The server (`POST /mobile/punches`) records each punch once.** It is keyed on the device and sequence, and it sets the time this way:
   - When the punch was made and sent in the same app run, its time is server time minus the monotonic time since capture. If that is more than 2 minutes from the phone's clock, the punch is flagged `clock_changed`.
   - Otherwise the phone's clock is used, flagged `clock_unverified`.
   - `offline` and `mock_location` are also flagged.
   - Flags are shown in the app and on the attendance day page. They are not hard blocks.
4. **Refusals, with a reason:**
   - Older than 72 hours: ask for a correction instead.
   - More than 2 minutes in the future.
   - Outside the geofence when it is enforced. This is audited.
   - Location required.
   - Mobile punching turned off.
   - Before joining, or after leaving.
5. **Refused punches** move to a "Not recorded" list on the phone. Nothing is dropped silently.
6. **Locked periods:** a punch for a locked payroll period is stored but not applied, and says so.

### Devices and push
- **Registration:** on sign-in the phone registers with a random installation id. Each device belongs to one workspace membership.
- **Sign-out:** signing a device out, from the app or from **Settings → Security → Mobile app** in the Web Portal, does three things:
  - revokes its sign-in;
  - removes its push token;
  - makes the server refuse its queued punches.
- **Push:** `notify()` queues a push message for every signed-in device with push on.
  - The content is always generic: "You have something new in CREW", carrying only the notification id and link. The app loads the details after sign-in.
  - Tokens Expo reports as no longer registered are removed.
  - Delivery runs only when `EXPO_PUSH_ENABLED=true`. `EXPO_ACCESS_TOKEN` is optional.

### Web Portal screens
- **Workspace:**
  - **Announcements:** feed and detail with acknowledge.
  - **Ask HR:** my cases, ask a question, help articles, and the case page.
- **Organization:**
  - **HR helpdesk queue:** filters, search, target badges, and logging a case on someone's behalf.
  - **Manage announcements:** drafts, audience, publish, archive, and a read-receipts page.
- **Administration:** **Helpdesk settings** for categories, handlers, targets and articles.
- **Home:** the announcements and Ask HR cards.
- **Settings → Security:** signed-in phones.
- **Attendance day page and today card:** show the mobile punch checks.
- **All pages:** a record that does not exist, or that you may not see, now shows the 404 page instead of an error page.

### Who can do what

| Permission | Default holders | Scope |
|---|---|---|
| `helpdesk:use` | Everyone | Own |
| `helpdesk:manage` | HR admin (workspace), HR manager (their legal entity) | Entity or workspace; never managers |
| `helpdesk:configure` | HR admin | Workspace |
| `announcements:read` | Everyone | Own |
| `announcements:manage` | HR admin | Workspace |

Device routes act only on the caller's own devices.

## Demo data
Everything below is labelled as demo data.

- **Handlers:** the HR admin handles Pay, Leave and Documents.
- **Grievance:** a confidential **Grievance** category, handled by the HR admin only.
- **Help articles:** three, on reading a payslip, a forgotten punch-out, and an address proof letter.
- **Cases:** three. Neha has one in progress with a reply from HR, and one open and unassigned. The QA lead has one resolved and waiting for confirmation.
- **Announcements:** two. A pinned welcome for everyone, and a safety-shoes notice for Manufacturing that asks for acknowledgement.

## Tests
- **Contracts:** 81 unit tests. Phase 7 adds:
  - helpdesk moves, targets and priority factors;
  - capture-time and clock checks for offline punches;
  - age and future checks.
- **API:** 194 integration tests. Phase 7 adds `test/helpdesk.spec.ts` (13) and `test/mobile.spec.ts` (9), covering:
  - **Cases:** numbering and auto-assignment; the full case life cycle and who may make each move; internal notes hidden from the employee; confidential categories (handlers only, managers and out-of-entity HR get 404, views audited); no case text in the audit trail; auto-close after 7 days; rating once.
  - **Announcements:** audience rules including sub-departments; freeze after publishing; receipts and acknowledgements.
  - **Devices and push:** device registration and sign-out ending the session; push queueing, a stub push server, and removing stale tokens.
  - **Offline sync:** duplicates, clock flags, too old, future, geofence refusal and locked periods.
  - **Isolation:** of the new tables, by database role and by API.
- **Mobile app:** 15 unit tests (Vitest). They cover:
  - **Offline queue:** survives failures, keeps order, batches of 50, one send at a time, refusals listed with the reason.
  - **API client:** one shared token refresh, and no sign-out on a network error.
  - **Formatting:** exact money formatting with Indian digit grouping, and the mapping from notification links to app screens.
- **Browser:**
  - `e2e/helpdesk-flow.cjs` (12 steps) and `e2e/mobile-flow.cjs` (14 steps). Both fail on any browser error.
  - The mobile flow runs the browser build of the app at phone size. It switches the network off to test the offline queue.
  - CI builds the app for the browser, then runs the flows in this order: web, hr, talent, helpdesk, attendance, payroll, mobile, recruitment. Helpdesk and mobile run before recruitment, because the recruitment flow turns on two-step sign-in for the HR admin.

### Defects found and fixed during this phase
- **An SQL string was built from an id.** An early version of the helpdesk reply built part of an SQL statement by inserting an id into the text. It now uses a parameter.
- **The offline queue could not tell when the phone had restarted.** It first relied on the monotonic clock alone, which restarts with the app. The run id and the `clock_unverified` flag fix that.
- **Missing or hidden records showed an error page.** In the Web Portal, opening a record that does not exist or that you may not see showed a generic error page with status 500. It is now a 404 page.

## Security verification
- **Tables:**
  - All 11 new tables have forced Row-Level Security and composite workspace foreign keys.
  - Case messages and case history are insert-only for the API role. The push queue is insert-only.
  - Closed cases, published announcements and acknowledgements are frozen by trigger.
- **Confidential cases** are filtered in the database query, not after loading. Every view of a confidential case by a handler is audited, and the case text stays out of the audit trail.
- **Mobile:**
  - Tokens are in the phone's secure storage, never in plain app storage.
  - Push content is generic.
  - Devices are personal, and remote sign-out ends the session.
  - The offline queue cannot backdate a punch beyond 72 hours or push one into the future, and a changed phone clock is flagged.
- **Routes:** every new route declares its permission and plan feature. The OpenAPI spec now has 384 operations.
- **CORS:** the mobile browser build's origin must be listed in `CORS_ORIGINS`. Native apps do not use CORS.

## Differences from the Phase 0 mobile design
The architecture pack ([07-mobile-architecture.md](../architecture/07-mobile-architecture.md)) planned some things that this first version does differently or does not have yet:

- **Offline queue storage:** it is JSON in the phone's app storage, not SQLite, and punches are not signed with a device key. Duplicate protection comes from the registered device id and sequence number, and the punch is sent with the user's session.
- **Biometric unlock** is an app lock. It does not encrypt the refresh token.
- **Not built:**
  - certificate pinning;
  - root and jailbreak detection (only the operating system's mock-location signal is used);
  - universal links (the app uses the `crew://` scheme).
- **Local data at sign-out:** when the server ends a session, the app clears its tokens. Queued punches stay on the phone so they can be sent after the next sign-in.

## Next: Phase 8 (AI and automation)
As planned in the roadmap: copilots, the workflow studio and predictive insights. Every suggestion will be explained and need a person's approval.
