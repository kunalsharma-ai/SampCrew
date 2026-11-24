# Delete permissions and the password before every delete (2026-11-23)

Migration: `0180_delete_permissions`. Tests: `apps/api/test/delete-permissions.spec.ts` and
`e2e/delete-permissions-flow.cjs` (`pnpm e2e:delete-permissions`). Registry: `packages/contracts/src/delete-permissions.ts`.

## The rule

Every delete, at every level, needs two things:

1. **Permission from the level above.**
   - The Console allows deletes for each Super Workspace, per area. Find it at Clients > a company > Features &
     permissions > Delete permissions. All areas are allowed by default.
   - The Super Workspace gives delete permission to HR Workspace (for each HR Workspace) and to Employee Workspace,
     per area. Find it at Settings > Workspace Permissions > Delete permissions. All areas are off by default.
   - An area the Console has switched off is shown as "Not allowed by Console Admin". The Super Workspace cannot
     give it to anyone.
   - Console admins delete only if their Console role has `records:delete`. The super_admin, admin, billing_ops and
     operations roles have it. Migration 0180 also gives it to custom roles that could already change something
     deletable.
2. **The person's own password, typed just before the delete.**
   - The password is checked by `POST /me/delete-confirmation`, or `POST /platform/auth/delete-confirmation` in the
     Console.
   - A correct password lets that session make one delete within two minutes. The guard uses the confirmation up in
     the same database write that checks it, so a second delete needs the password again.
   - A wrong password counts as a failed sign-in, so the usual lockout applies.
   - API keys can never delete.

Without permission, the apps hide the delete option. The API also refuses the delete with `delete_not_permitted`, and
the message names the level that has to switch it on. Without the password, the API answers
`delete_password_required`.

## Areas

There are 13 areas:

- people
- organization
- leave
- attendance
- payroll
- recruitment
- performance
- learning
- documents
- communication
- assets
- settings
- personal

The registry lists every delete route with its area, and the guard checks every request against it. Some actions
count as deletes only with a certain body. Examples are archiving an HR Workspace, archiving a custom field, and a
candidate bulk archive.

The registry test fails in either of these cases:

- A `DELETE` route, or an archive or erase route, is in neither the registry nor the short list of things that are
  not deletes. That list holds the person's own sign-in sessions, their own unfinished hire form, a scheduled plan
  change, permission templates, their own signature agents and SCIM.
- A registry entry matches no route.

Employee Workspace can have only these areas:

- people: their own photo
- attendance: draft rosters of their own team, for managers
- performance
- documents
- communication
- personal: their saved views, AI conversations and similar

## Audit

- Every delete that runs writes `delete.performed`. The entry records the area, what was deleted, the route and its
  ids, and `reauthenticated: true`. Modules keep their own detailed entries too.
- A refused delete writes `delete.denied`.
- The password step writes `delete.password_confirmed` or `delete.password_failed`.
- A Console change to a company's delete permissions writes `access.delete_rights_changed`.

## Apps

- **Web and Console.** A delete button carries `data-delete-area` and `data-delete`.
  - The shell hides it when the area is not in `me.deleteAreas`. In the Console it is hidden without
    `records:delete`.
  - A click opens "Confirm with your password", then goes on with the click.
  - `useMfaRetry` also handles `delete_password_required` for actions that start from elsewhere.
- **Mobile.** `apps/mobile/src/lib/api.ts` asks for the password through the password sheet and retries once.
  "Remove photo" shows only with the people area.

## Demo and tests

- The demo workspace's Super Workspace has given HR Workspace (central) and Employee Workspace every area they can
  have, so the demo shows the password step. A new workspace starts with none.
- API tests switch them on in `createTenant`. Pass `deletes: false` to turn that off; the delete-permissions spec
  does.
- Browser flows require `e2e/delete-password.cjs`, which types the password into the dialog.
