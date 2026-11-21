# Forgot password (every level)

Everyone who signs in to SampCrew can reset a forgotten password by email:

| Level | Where | What they get |
| --- | --- | --- |
| Console Admin | Console sign-in > "Forgot password?" | A link to the Console's `/reset-password` page and a 6-digit code |
| Super Workspace, HR Workspace, Employee Workspace | Web Portal sign-in > "Forgot password?" | A link to the Web Portal's `/reset-password` page and a 6-digit code |
| Same people, phone app | Sign-in screen > "Forgot password?" | The same email: they type the 6-digit code in the app |

## Before it works: email delivery

Reset emails go out through the email settings in **Console > Integrations > Email** (stored in the database, like every
other key). Until email is set up, requests are recorded but nothing is delivered: the Password resets pages show
"Email not set up" for each one.

Links in Console emails use `CONSOLE_PUBLIC_URL` (or `https://` + `CREW_CONSOLE_ADDRESS` when that is not set). Links in
workspace emails use `WEB_PUBLIC_URL`.

## Rules

- The link and the code work **once**, for **30 minutes**, and only the newest request counts (an older link stops working).
- The answer on screen is the same whether or not an account uses the email, so nobody can find out who has an account.
- At most **3 emails an hour** per account; more requests are recorded as "Too many requests" and send nothing. The
  request endpoint is also limited to 5 calls a minute per address.
- **5 wrong codes** stop the request; the person asks for a new one.
- Setting the new password **signs out every session** (web, phone, Console), clears a sign-in lock and a "change your
  temporary password" flag, and sends a "your password was changed" email.
- Two-step verification is **not** removed: the authenticator code is still asked at sign-in. A lost authenticator is
  still reset by an admin (Console > Console admins > Reset two-step, or the workspace's own process).
- Only hashes of the link token and the code are stored (`password_resets.token_hash`, `code_hash`). Once the email has
  gone out and the reset is used, the stored copy of the email no longer holds the link.
- Suspended people, and people with no active workspace, get no email (recorded as "Account not active").

## Where it shows up

- **Console > Password resets** (Console admins with `audit:read`): every request at every level, including emails with no
  account, with level, workspace, status, email delivery, app and address. Filter by level, status or name.
- **Super Workspace > Administration > Password resets** (`/settings/password-resets`, Super Workspace level only): requests
  by the company's own people (HR Workspace and Employee Workspace included). Never other companies, never unknown emails.
- **Audit trails**: `auth.password_reset_requested`, `auth.password_reset_completed`, `auth.password_reset_refused`,
  `auth.password_reset_locked` in each of the person's workspaces and in the platform trail.

## API

| Route | Who |
| --- | --- |
| `POST /auth/password-reset/request` `{ email }` | Public (Web Portal and phone app) |
| `POST /auth/password-reset/check` `{ token }` | Public |
| `POST /auth/password-reset/complete` `{ token, newPassword }` or `{ email, code, newPassword }` | Public |
| `POST /platform/auth/password-reset/request \| check \| complete` | Public (Console) |
| `GET /platform/password-resets?level&status&q&tenantId&limit&offset` | Console, `audit:read` |
| `GET /password-resets?level&status&q&limit&offset` | Super Workspace (`users:read` and the Super Workspace level) |

## Tests

- `apps/api/test/password-reset.spec.ts`: link and code flows, single use, expiry, newest-only, hourly limit, wrong-code
  lock, sessions revoked, MFA kept, suspended people, Super Workspace and Console lists and who may read them.
- `e2e/password-reset-flow.cjs` (`pnpm e2e:password-reset`, in CI): Web Portal link flow, phone app code flow, Super
  Workspace page, Console Admin reset and Console page, in Chromium.
