# Phase 14 report: switching features and permissions on or off from the Super Admin Console

Kunal asked for every CREW feature and permission to be selectable as active or inactive from the Super Admin
Console, and for SAMPLEDGE to choose which features each user is allowed.

Each workspace now has a **Features & permissions** page in the Console (Workspaces > a workspace > Features &
permissions) with three tabs:

- **Modules:** every CREW module has an Active switch. A module can follow the plan, be forced on (even when the
  plan does not include it), or be forced off. Activate all, Deactivate all and Reset all to plan are one click.
  Core HR is the foundation and stays on.
- **Permissions:** every permission in the catalogue has an Active switch, grouped by module, with a switch per
  group. An inactive permission is removed from every role in the workspace, the owner's included, and the
  workspace cannot grant it back from Settings > Roles.
- **People:** search the workspace's members and choose, per person, which modules they may use. Everyone else keeps
  every active module their roles allow.

## Working end to end, and not yet

### Working end to end

API tests are in `apps/api/test/access-controls.spec.ts` (10 tests); the browser flow is `pnpm e2e:access`
(`e2e/access-flow.cjs`, its own CI step on a fresh database).

- **Enforced by the API, not only hidden.** A switched-off module answers 403 `feature_disabled`; a module taken away
  from one person answers 403 `feature_not_for_member`; a module the plan lacks still answers 402
  `feature_not_in_plan`. A switched-off permission is removed from the member's effective grants when they are
  loaded, so every route check, record-level check, approval routing and workflow run sees the same thing.
  Changes take effect on the next request; nothing is cached across requests.
- **Stored in PostgreSQL** (migration `0021_access_controls.sql`): module switches in `subscriptions.feature_overrides`;
  permission switches in `tenant_access_controls`; per-person module access in `member_feature_access`. The
  workspace's own database role can read the two new tables (so the apps can explain what is off) but cannot write
  them. **Verified** by a test that tries.
- **More modules can be switched.** New module keys: `helpdesk`, `announcements` (both previously under
  `self_service`), `crew_iq`, `workforce_universe` and `staffing_bids` (previously under `recruitment`). Leave and
  documents routes now check their modules too. Plans include the new keys wherever the old ones were, so no
  workspace loses anything on upgrade (the catalogue sync in the `migrate` job applies them).
- **Web Portal and mobile app hide what is off.** `/me` returns the modules in effect for the person, why any are
  missing (`featureBlocks`) and the switched-off permissions (`disabledPermissions`). Navigation, the Create menu,
  the command palette, CREW IQ's button and shortcut, the home page cards, the employee profile's Leave and
  Documents tabs, and the mobile Leave, Ask HR and announcements all follow it. Opening a switched-off page shows
  "This module is switched off" or "This module is not available to you". Settings > Roles marks switched-off
  permissions and will not let them be added to a role. CREW IQ refuses questions about switched-off modules.
- **Who can change it.** Only Super admins (new console capability `access:manage`). Viewers, Support and Billing
  operations can see the Modules and Permissions tabs read-only; the People tab is Super admin only because it lists
  members. **Verified** by tests.
- **Audited twice.** Every change is written to the platform audit log and to the customer's own audit trail
  (`access.modules_switched`, `access.permissions_switched`, `access.member_modules_changed`) with before and after.
- **Verified in a browser:** the console admin switches Staffing bids off and the recruiter loses it; switches
  leave:configure off and HR loses Leave settings, with Roles showing it as switched off by SAMPLEDGE; takes
  Recruitment away from the recruiter only and HR keeps it; then switches everything back. The accessibility check
  now covers all three tabs in light and dark (0 violations).

### Not yet

- **Plan-level editing.** Plans still get their module lists from `packages/contracts/src/features.ts` on each
  deploy. Changing what a whole plan includes from the Console would need the catalogue sync to stop overwriting
  console edits; not done.
- **Workspace admins cannot take modules away from their own people.** Per-person module access is set by
  SAMPLEDGE only, as asked. Customers shape access inside modules with roles.
- **People tab shows account details only** (name, email, roles, status), in line with the rule that SAMPLEDGE
  staff never see HR records without a support grant.
- **The mobile app** was checked by type checking only in this phase; its tabs follow the same `/me` fields the web
  uses.
