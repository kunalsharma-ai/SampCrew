# Super Admin Console admins

Who can sign in to the SAMPLEDGE Super Admin Console, how the first Super admin is created, how to add and remove
colleagues, and what to do when nobody can sign in.

## Roles

| Role | Can |
| --- | --- |
| `super_admin` | Everything, including Console admins, Integrations and workspace access switches |
| `support` | See workspaces, request customer-approved support access, System health, Platform audit |
| `billing_ops` | Plans and prices, subscriptions, Billing & revenue |
| `viewer` | Read-only: workspaces, billing, health |

The full list is `PLATFORM_ROLE_CAPABILITIES` in `packages/contracts/src/roles.ts`. Console admins are a separate
realm from workspace users: their own collection (`platform_admins`), signing key (`JWT_PLATFORM_SECRET`) and
sessions. Every console action needs two-step verification (an authenticator app); nobody can turn it off.

## 1. The first Super admin

Set these two values before the first start (in `infra/deploy/.env` for the Docker deployment, `.env` locally):

```sh
CREW_BOOTSTRAP_ADMIN_EMAIL=you@sampledge.com
CREW_BOOTSTRAP_ADMIN_PASSWORD=<at least 14 characters, not a template value>
```

The `migrate` job (`pnpm db:seed` locally) creates that account only when there is no console admin at all, so the
values do nothing on later deploys. In production the seed refuses a password shorter than 14 characters or one
containing `changeme`, `example` or `password`.

First sign-in:

1. Open the Console (`https://console.<your domain>`, from a network allowed by `CONSOLE_ALLOWED_IPS`).
2. Sign in with the bootstrap email and password.
3. Scan the QR code with an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password...) and
   enter the 6-digit code. Keep the key shown under the QR code somewhere safe, such as your password manager.
4. Change the bootstrap password: the key button next to your name opens **Change password**.
5. Remove `CREW_BOOTSTRAP_ADMIN_PASSWORD` from `.env` (or your secret manager). It is never used again.

## 2. Adding colleagues

Console > **Console admins** > **Add admin**: name, email, role and a temporary password (12+ characters, three of
lowercase, uppercase, numbers, symbols). Send the password through a secure channel, never in the same email as the
console address.

At their first sign-in the new admin sets up two-step verification, then must choose their own password before any
console page opens. Add at least **two** Super admins, so one can always help the other.

## 3. Day-to-day changes (Console > Console admins > Manage)

| Situation | Action | Effect |
| --- | --- | --- |
| New responsibilities | Change the role | Signed out at once, so the new role applies immediately |
| Forgot their password | Set temporary password | Lockout cleared, signed out, must choose a new password at next sign-in |
| Lost or replaced phone | Reset two-step verification | Signed out; sets it up again at next sign-in |
| Five wrong attempts (15-minute lock) | Unlock now | Can sign in straight away |
| Leaves SAMPLEDGE | Disable access | Signed out everywhere, cannot sign in; history is kept. Re-enable restores it |

Rules the API enforces: nobody changes their own role or status or resets their own password or two-step
verification from this page, and the last active Super admin cannot be demoted or disabled (two Super admins
demoting each other at the same moment cannot both succeed). Everyone changes their own password from the key button.
Every change is in **Platform audit** (`platform.admin_*`, `platform.password_changed`).

## 4. Recovery command: when nobody can sign in

For when the only Super admin lost their phone, forgot their password, is locked out or has left. It works directly on
the database, so it needs shell access to the server. Every change signs the admin out everywhere and goes to the
platform audit trail as "recovery command (user@host)".

Docker deployment (from `infra/deploy`, the `migrate` service already has the admin database connection):

```sh
docker compose run --rm migrate /app/infra/deploy/scripts/admin.sh list
docker compose run --rm migrate /app/infra/deploy/scripts/admin.sh reset-mfa      --email you@sampledge.com
docker compose run --rm migrate /app/infra/deploy/scripts/admin.sh reset-password --email you@sampledge.com
docker compose run --rm migrate /app/infra/deploy/scripts/admin.sh unlock         --email you@sampledge.com
docker compose run --rm migrate /app/infra/deploy/scripts/admin.sh create  --email new@sampledge.com --name "New Person"
docker compose run --rm migrate /app/infra/deploy/scripts/admin.sh set-role --email someone@sampledge.com --role support
docker compose run --rm migrate /app/infra/deploy/scripts/admin.sh disable  --email leaver@sampledge.com
docker compose run --rm migrate /app/infra/deploy/scripts/admin.sh enable   --email someone@sampledge.com
```

Developer machine or any host with the source: `set -a; . ./.env; set +a`, then `pnpm db:admin <command> ...` with
the same arguments.

- `create` makes a Super admin unless `--role` says otherwise. `create` and `reset-password` print a random
  temporary password once; to choose it yourself, pass `-e CREW_ADMIN_PASSWORD=...` to `docker compose run`
  (or set `CREW_ADMIN_PASSWORD` locally). Either way the admin must replace it at the next sign-in.
- `disable` and `set-role` refuse to remove the last active Super admin: `create` or promote another first.
- Exit code 0 on success, 2 for a usage problem (unknown email, bad role, weak password), 1 for a database error.

## 5. Checks

- `GET /api/v1/platform/admins` (Super admins) lists everyone with role, status, two-step state, lockout and whether
  they still have a temporary password.
- Tests: `apps/api/test/console-admins.spec.ts` (API rules and the recovery command), the "Console admins" part of
  `e2e/console-smoke.cjs` (browser).
