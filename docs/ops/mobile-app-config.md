# Mobile app configuration (Super Workspace)

One SampCrew mobile app serves every workspace and every level (Super Workspace, HR Workspace, Employee
Workspace). What a person sees on the phone is decided in two layers:

1. **The workspace's published mobile configuration**, set by the Super Workspace in the Web Portal under
   Settings, Mobile app (permission `mobileapp:manage`).
2. **The person's own access**: their permissions, their level and the workspace's plan entitlements. The
   configuration can only hide things; it never grants a permission, and it holds no secrets.

## What the Super Workspace controls

- **Modules and features**: show or hide each module (Attendance, Leave, Chat, Email, Documents, Learning,
  Announcements, Notifications, Approvals, Tasks, Appraisal, Payslips, Help and support, Employee directory,
  Login and session details) and each feature inside it, per level. Home and My profile are always on.
  A feature that depends on another (for example Breaks needs Check in and out) is switched off with it.
- **Bottom bar**: which modules are tabs and their order (up to four plus More). Everything else is listed in
  More.
- **Home**: the widgets and quick actions per level, in order.
- **Draft, preview, publish**: changes are saved as a draft; the phone preview on the page shows the draft for
  a chosen level. Publishing a change that hides something people used in the last 30 days asks to confirm and
  says where the work moves (for example "Email moves to the Web Portal only").
- **History and restore**: every published version is kept with who published it and what changed; any
  version can be restored, which publishes it as a new version.

## How the phone follows it

- `GET /mobile/app` returns the resolved app for the signed-in person (modules, features, tabs, home, and
  `setup.email` as true or false only). The phone polls it on start, on return to the foreground and every minute
  while open, and caches the last copy so it works offline. Hidden screens show "Not available in the app" with a
  pointer to the Web Portal.
- **Server enforcement**: sessions signed in from the phone (`x-crew-client: mobile`) are checked on every
  request against the published configuration. A route owned by a hidden module or feature returns
  `403 mobile_module_off`. Web Portal sessions are never affected by the mobile configuration.

## API

| Route | Who | What |
| --- | --- | --- |
| `GET /mobile/app` | anyone signed in | the resolved app for this person |
| `GET /mobile-app` | `mobileapp:manage` | catalogue, draft, published version |
| `PUT /mobile-app/draft` | `mobileapp:manage` | save the draft |
| `POST /mobile-app/draft/discard` | `mobileapp:manage` | drop the draft |
| `POST /mobile-app/publish` | `mobileapp:manage` | publish the draft (`confirmHidingInUse` when it hides used modules) |
| `GET /mobile-app/versions`, `/versions/:v` | `mobileapp:manage` | history |
| `POST /mobile-app/versions/:v/restore` | `mobileapp:manage` | restore a version |
| `GET /mobile-app/preview?level=` | `mobileapp:manage` | what a level would see with the draft |

Every change is written to the audit trail.

## Breaks and sign-in history

- Punches carry `purpose`: `work` or `break`. The server refuses a break out of order (`already_in`, `not_in`,
  `no_break`, `on_break`), and today's state is one of working, on break, checked out or not started.
- `GET /auth/sign-ins` groups refresh rotations into one sign-in per device and returns the current and
  previous sign-in; tokens are never returned. `POST /auth/sessions/sign-out-others` ends every other session.

## Tests

`pnpm e2e:mobile-app` (`e2e/mobile-app-flow.cjs`) runs the whole loop against the real API: the Super
Workspace hides Email, the preview follows, publish asks to confirm, the phone loses Email and its API is
refused while the Web Portal still works; breaks; chat with read receipts; a course assigned by HR and
completed on the phone; sign-in history; Email shown again and History.
