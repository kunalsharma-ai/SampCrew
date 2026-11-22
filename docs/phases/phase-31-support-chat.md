# Phase 31: SampCrew Support chat and sender identity

Kunal's brief "Centralized Communication & Internal Chat System". The existing Communication chat (PR #53) is extended,
not rebuilt: same live events, notifications and read/delivery model.

## What was built

### A. SampCrew Support (Super Workspace <-> Console Admin team)

- **Web Portal** `/support` ("SampCrew Support" in the menu for the Super Workspace level, a "SampCrew Support" tab in
  Communication, and a pinned entry at the top of the chat list). Start a conversation with a subject, topic and
  message; chat; see Sent / Delivered / Read; mark resolved or reopen. Replies arrive live and as a notification.
  Every Super Workspace person of the company sees the same conversations; each has their own unread count.
- **Console** `/support` ("Support inbox", with an unread badge in the menu). Columns: Super Workspace, subject, last
  message, status (Unread, Waiting for reply, Replied, Resolved), last activity. Search by workspace, subject or
  message text; filter by status or one workspace. Open a conversation to reply, mark it unread for the team, or
  resolve it. A side panel shows the company (status, plan, Super Workspace people). Updates live over `/live`.
- **The Console Admin team**: any admin with the new `support:chat` capability (Super admin, Support roles) can read and
  answer. Read state is per team. Each reply records the actual admin ("Sana Support, Console Admin, SampCrew Support");
  the conversation shows who answered last.
- **Access**: HR Workspace and Employee Workspace get 403 on every support route and do not see the menu item; another
  company's conversation id is 404 (tenant-scoped tables); Console roles without `support:chat` get 403; a workspace
  token on Console routes is 401. Support messages never appear in the internal chat or its search.
- Works on every plan and while a subscription is locked (that is when customers most need to reach SAMPLEDGE).

### B. Sender identity in the internal chat

- Every chat message carries the sender's **name, level (Super / HR / Employee Workspace) and workspace** (the company,
  or the HR Workspace they belong to or run). Kept on the message when it is sent (`chat_messages.sender_level`,
  `sender_workspace`), so history stays accurate; older messages show the sender's current level.
- Direct conversations show the other person's level and workspace in the list and the thread header; group members
  show their level; notifications read "New message from Amit Sharma (Super Workspace)".
- **New conversation** picker shows level, workspace, employee ID and email, and searches by any of them.
- Chat list filters: All, Unread, Direct, Groups, HR.

## Data

New tenant-scoped collections (no data migration needed; `syncCollections` creates them and their indexes):
`support_conversations`, `support_messages`, `support_reads`. New optional columns `chat_messages.sender_level`,
`chat_messages.sender_workspace`, `live_events.console`. Migration range 0120s was reserved; nothing needed a
numbered migration.

## Tests

- `apps/api/test/support-chat.spec.ts` (6 tests): the brief's tests 1 to 5 plus resolve/unread/search.
- `e2e/support-chat-flow.cjs` (`pnpm e2e:support-chat`): Web Portal and Console in Chromium, including live
  delivery, Read ticks, notification, the employee refused, the employee seeing the Super Workspace sender, phone width.
- Existing `communication.spec.ts`, plan coverage, notifications, tenant isolation, platform and production suites pass unchanged.

## Working end to end

Everything above, in the Web Portal and Console.

## Not yet

- The phone app does not have a SampCrew Support screen. The phone chat comes with PR #67; the API already returns the
  sender identity fields, so its screens can show them after both merge.
- No file attachments in support messages (text only).
- No assignment of a conversation to one Console Admin; the team answers together and "handled by" shows the last one.
- Console Admins are not emailed about new support messages; they see the live badge and inbox.
