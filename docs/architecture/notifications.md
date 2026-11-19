# Notifications and live updates

One service sends every notice in SampCrew: the bell, Home, the Notification Center, phone pushes and the email
copies. Any module that needs to tell someone something calls `NotificationService.notify` inside its own
transaction, so a notice exists only if the change that caused it was saved.

## Sending a notice

```ts
constructor(private readonly notifications: NotificationService) {}

await this.notifications.notify(tx, {
  membershipIds: [employeeMembershipId],   // recipients; null, duplicates and suspended members are skipped
  kind: 'leave.approved',                  // module.event; the prefix picks the category
  title: 'Leave approved',
  body: 'Casual leave, 2 Dec',             // optional
  link: '/leave',                          // optional; opening the notice goes there
  priority: 'normal',                      // low | normal (default) | high | urgent
  email: true,                             // optional; also email it, unless the person turned email off
  category: 'leave',                       // optional; overrides the category from `kind`
  dedupeKey: `chat:${conversationId}`,     // optional; repeats fold into one unread notice ("3 updates")
  resource: { type: 'leave_request', id }, // optional; the record it is about
  actorMembershipId: me,                   // optional; shown as "from ..." in the Notification Center
});
```

It returns the number of people who were notified.

### Categories

Categories are listed in `@crew/contracts` (`NOTIFICATION_CATEGORIES`). If `category` is not given, it is worked
out from `kind` by `categoryOfKind`, which uses the longest matching prefix:

The main prefixes (the full list is `PREFIXES` in `packages/contracts/src/notifications.ts`):

| Prefix | Category |
| --- | --- |
| `approval.` | approvals |
| `leave.`, `leave_` | leave |
| `attendance.`, `late_coming`, `shift_swap.`, `roster.` | attendance |
| `chat.`, `email.`, `communication.`, `helpdesk.` | communication |
| `announcement.` | announcements |
| `task.`, `onboarding.` | hr_tasks (pass `category: 'manager_tasks'` for tasks meant for managers) |
| `task.document_reviewed`, `document.`, `document_verification.` | documents |
| `appraisal.`, `review.`, `goal.`, `learning.` | appraisal |
| `profile_update.`, `employee.` | profile |
| `bgv.`, `background_verification.` | verification |
| `asset.` | assets |
| `requisition.`, `candidate.`, `interview.`, `offer.` | recruitment |
| `payroll`, `payslip.`, `expense.` | payroll |
| anything else | system |

To add a category, add it to `NOTIFICATION_CATEGORIES`, give it a prefix in `categoryOfKind`, and add a label in the
web app's `CATEGORY_LABEL` if it needs a different label there.

### What the person controls

People choose, in **Settings > Notification settings**, whether each category shows in SampCrew and whether it is
emailed. Approvals and workspace notices (`MANDATORY_CATEGORIES`) always show. If someone turned a category off in
SampCrew, the notice is not stored for them. If they turned email off, `email: true` sends nothing. Workspace notices
(`system`) are always emailed when `email: true`.

Sound is off until the person switches it on. It plays only for notices that arrive while a page is open, never when a
page loads, and only after they have clicked or typed on the page (browsers require this). They choose the volume and
the lowest priority that makes a sound. Corner pop-ups are on by default and can be switched off.

### Folding repeats

With `dedupeKey`, a new notice replaces the person's unread notice with the same key: the title and body are updated,
`count` goes up, and it moves to the top. Once it has been read, the next event starts a new notice. Phone pushes are
sent only for new notices, not for folded updates.

## Live updates without notices

Some changes should refresh someone's screen without a notice (a chat read receipt, an approval decided elsewhere).
Use `signal`:

```ts
await this.notifications.signal(tx, membershipIds, 'approvals.changed', { requestId });
```

Signals and notices are written to `live_events` in the same transaction. `LiveService` watches that collection (with
a MongoDB change stream, or by polling when change streams are not available), sends each event to the recipients'
open connections, and deletes events older than an hour.

Event types the web app listens to: `notification`, `notifications.read`, `chat.message`, `chat.read`,
`chat.updated`, `approvals.changed`, `announcements.changed`, `leave.changed`. To add one, add it to the list in
`apps/web/components/live.tsx`. A page that should refresh on an event calls `useRefreshOn(['approvals.changed'])`.

## Marking read

`markReadByLink(tx, membershipId, '/approvals/123')` marks a person's unread notices about one page read. A page can
call it when that person opens the record, so the bell clears without them opening the notice itself.

## HTTP API

All routes are under `/api/v1/notifications` and act for the signed-in person. See `docs/api/openapi.json` for the
exact shapes.

| Route | What it does |
| --- | --- |
| `GET /` | Notices, newest first. Filters: `unread`, `category`, `priority`, `q`. Paging: `before`, `limit` |
| `GET /unread-count` | The unread count |
| `GET /summary` | Unread and total per category, and the latest important unread notices |
| `POST /:id/read`, `POST /:id/unread` | Mark one notice read or unread |
| `POST /read-all` | Mark all read, or one `category`, or those about one `link` |
| `GET /preferences`, `PUT /preferences` | Category, sound and pop-up preferences |
| `GET /stream` | Server-sent events (`ready`, then the live event types above; a heartbeat every 25 seconds; it closes after 15 minutes and the browser reconnects) |

The Web Portal never calls the API from the browser: `/live` passes the stream through with the session token.
