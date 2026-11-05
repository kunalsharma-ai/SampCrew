# Phase 16 report: SAMPLEDGE Super Admin control of every workspace

Kunal asked (2026-11-05) for the Super Admin to control everything a workspace admin is given: which features are
active, for the Web Portal and the mobile app separately; the subscription; the workspace's activity; the people its
admins add (view and act on them); and which attendance machines it has integrated, with attendance machine
integrations in both the admin's Web Portal and the Console. The Console takes the neon design too.

This builds on Phase 14 (module, permission and per-person switches) rather than replacing it.

## What was built

### Console in the neon design
- The Console uses the same neon style as the Web Portal (`@crew/ui/styles.css`): night sidebar with a gradient pill
  for the current page, aurora backdrop, glass cards, gradient KPI tiles and gradient primary buttons.
- A palette button next to the dark-mode button switches between the neon and classic looks (kept per browser).
- Every workspace now has tabs: **Overview & subscription**, **Features & permissions**, **Users**, **Activity**,
  **Attendance machines**. Two new sidebar pages: **All users** and **Attendance machines** (every workspace).

### Features per app (Features & permissions > Web & mobile apps)
- Switch the **Web Portal** or the **mobile app** off for a workspace. Its open sessions end at once, sign-in to it
  is refused with `app_switched_off`, and every request on an older session is refused too. At least one app stays on
  (to stop everything, suspend the workspace).
- Switch any module off **in one app only** (for example Payroll on the web but not on phones). The API closes it
  for sessions opened in that app (`feature_off_in_app`), and `/me` reports it as `channel_off`, so the app hides it.
- Stored in `tenant_access_controls` (migration `0023_superadmin_control.sql`); audited as `access.apps_switched`.

### Subscription (Overview & subscription > Adjust subscription)
- Besides plan, status, seats and trial: **billing cycle**, a **negotiated price per seat**, the **current period
  end**, **renew or cancel at period end**, and **limits for this customer** (employees, legal entities, AI credits,
  storage; empty goes back to the plan). Limits are merged with module switches, so neither overwrites the other.
- A **Subscription history** table lists every change SAMPLEDGE made to plan, status, price and modules.

### Users (per workspace, and All users across workspaces)
- Everyone the workspace admins added: roles, status, account status, last sign-in, open web and mobile sessions,
  two-step verification, modules taken away. Search and status filters; counts at the top.
- Actions, each with a required reason, written to both the platform audit log and the customer's own trail
  (`membership.<action>_by_sampledge`):
  - **Sign out everywhere** (ends their sessions in this workspace),
  - **Suspend** / **Reactivate** (the workspace's only active owner cannot be suspended; suspend the workspace),
  - **Reset two-step verification** (ends their sessions in every workspace, as the authenticator is per account),
  - **Resend invitation** (new link, earlier links stop working).
- **Modules** opens the existing per-person module switches.

### Activity (per workspace)
- The customer's audit trail as headlines: what happened, who, when, from which app and address; filters by area and
  by who (person, SAMPLEDGE, system, AI, integration); paging. Tiles: events in 7 days, active people in 7 and 30
  days, web and mobile sign-ins in 30 days. Busiest areas over 30 days.

### Attendance machines
- **Web Portal, Settings > Devices** (workspace admins): a **Machine integrations** panel showing which makes are
  available; new makes **Hikvision, Matrix COSEC, Realtime, Suprema** and **Other machine or middleware**, besides
  ZKTeco and eSSL.
- **CREW device API** (new): `POST /api/v1/device-api/punches` and `POST /api/v1/device-api/heartbeat`, for machines
  that do not speak the ZKTeco push protocol, through their event forwarding, a vendor bridge or middleware. Each
  machine gets a token (`crewdev_…`, shown once, stored as a hash, "New token" replaces it). Up to 500 punches per
  call; times are read in the machine's time zone unless they carry an offset; repeats are ignored; punches go
  through the same pipeline as ZKTeco pushes (mapping to employees, day recompute, locks, ingest log).
- **Console**: per workspace, switch each **machine integration** on or off (its machines are refused and new ones
  cannot be registered), see every machine with live status, punches in 7 days and errors, and **pause** a machine
  with a reason (its pushes are refused and logged; the workspace sees "Paused by SAMPLEDGE" and the reason).
  **Attendance machines** in the sidebar lists every machine in every workspace.

## Who can do what in the Console
- Super admins: everything above.
- Users, Activity, app switches, machine integration switches, pausing machines: Super admin only (`access:manage`),
  because they show or change people's accounts.
- Machine lists: everyone who can see workspaces (`tenants:read`). Subscription history: `billing:read`.

## Working end to end, and not yet

### Working end to end
- API tests: `apps/api/test/superadmin-control.spec.ts` (12 tests: app switches and per-app modules enforced on
  sign-in, refresh and every request; people list and all five actions incl. the last-owner guard; activity without
  record contents; device API registration, token, punches, duplicates, time zones, rotation; pause and integration
  switch refusing pushes; subscription fields and limits merging with module switches). Full suite: 393 API tests.
- Browser flow `pnpm e2e:superadmin` (`e2e/superadmin-flow.cjs`, its own CI step on a fresh database) drives the
  Console, the Web Portal and the device API: neon design, subscription, mobile app off and Leave off on phones only,
  sign out / suspend / reactivate, activity, Hikvision machine registered by HR with a one-time token sending real
  punches, paused and resumed from the Console, integration switched off and on.
- Accessibility sweep (`e2e:a11y`) now also covers the new Console pages in light and dark.

### Not yet
- **Activity shows headlines, not record contents.** Before and after values (salaries, HR fields) stay behind an
  approved support request, as before. Say if SAMPLEDGE should see full contents without the customer's approval;
  that is a privacy decision for the customers' contracts.
- **App switches follow the app the session was opened in** (the app identifies itself at sign-in). A person who
  signs in to the API pretending to be the Web Portal gets the Web Portal's rules; API keys are not affected.
- **Vendor-native formats other than ZKTeco ADMS are not parsed.** Hikvision, Matrix, Realtime and Suprema connect
  through the CREW device API (their event forwarding or a bridge must send CREW's JSON). Not tested against real
  machines; only the API contract is tested.
- **Plan-level module editing** (changing what a whole plan includes) is still not in the Console.
- The mobile app was checked by type checking; it reads the same `/me` fields, and the API enforces every switch.
