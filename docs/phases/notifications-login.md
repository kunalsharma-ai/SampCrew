# Notification framework and animated sign-in welcome

One notification system for every workspace, and a welcome on every sign-in page.

## Level names used here

The spec names five levels. SampCrew has four, so two of them are mapped:

- **Console**: SAMPLEDGE staff (Console sign-in).
- **Super Workspace**: the organisation's top level.
- **Executive Workspace** → **HR Workspace**: the `hr` welcome scene.
- **Manager Workspace** → people in the **Employee Workspace** who lead a team (`/me` `levels.leadsTeam`): the `team` welcome scene, still labelled "Employee Workspace" (the UI naming rule).
- **Employee Workspace**: the `employee` scene.

`?space=manager` and `?space=executive` are accepted as aliases for `team` and `hr`.

## Notifications

- **One read state.** The bell, the Home widget, the module notices and the phone all read the same `notifications` rows. Reading a notice in one place clears it everywhere, live over `/live`.
- **Action needed.** `notifications.action_required` is set from the kind (approvals, assignments, `*.requested`, `*.awaiting_action`) or from `notice.action`. Migration `0170` backfills it. It is filterable as `?action=true`, counted in `/notifications/summary` `actionNeeded`, and shown as a badge in the bell, on Home, on module pages, in the Notification Center and on the phone.
- **Module notices.** Notices now also appear on 16 more web pages and on 4 phone screens (leave, attendance, approvals, learning).
- **Organisation policy.** Super Workspace only: Settings › Notification policy (`GET`/`PUT /notifications/policy`, audited as `notifications.policy_changed`). It sets:
  - categories that are always shown;
  - categories that are always emailed;
  - whether sound, desktop notifications and push are allowed;
  - starting choices for people who never changed their settings.

  The policy is applied whenever settings are read. People's own choices are kept, so relaxing the policy gives them back.
- **Per category channels.** Each category has In SampCrew / Email / Phone / Sound. Locked switches show why.
- **Sound.**
  - A short tone, only for notices that arrive live, never on page load.
  - With several tabs open, one tab plays it (a localStorage claim).
  - If the browser blocks audio, the tone plays on the next click within 2 minutes.
- **Phone push.**
  - The push is skipped when the category's Phone switch is off. It goes out silent when Sound is off.
  - Android channels: default, important, silent.
  - The app badge count follows the unread count.
  - A notice that arrives while the app is open shows once.

## Sign-in welcome

Each level is its own world, with the workspace's name written large ("You are signing in to **HR Workspace**").
The colours follow the product the person is about to enter (the level design systems in `packages/ui/src/styles.css`):

| Level | World | Animation |
| --- | --- | --- |
| Super Admin Console | Night-blue command centre | A turning wireframe globe with satellites and a radar sweep; live status panels; a scan line |
| Super Workspace | Emerald and gold | A crowned core with HR Workspaces orbiting it; gold links with light flowing; twinkling stars |
| HR Workspace | Violet and coral | A hiring board: a candidate card travels Applied → Interview → Hired and lands in confetti |
| Employee Workspace | Warm daylight | A rising sun and drifting clouds; a check-in that ticks; leave days filling a calendar; a payslip ready |
| Employee Workspace (leads a team) | Fresh daylight | Their team gathering and requests being approved |

- **Shared pieces.** `WelcomeScene` lives in `@crew/ui`. The text is `WELCOME_COPY` in `@crew/contracts`. Both use the official logo, unchanged: the dark version on dark worlds and the light version on daylight ones.
- **The sign-in form takes the same world's colours.** The page is wrapped in `.sc-shell[data-scene]`, which sets the accent, the button gradient and a top bar. The form renders straight away; nothing waits for the animation.
- **Motion.** Only transform and opacity animate. With `prefers-reduced-motion`, the whole scene is a still picture. A second visit in the same browser session plays a shorter version.
- **Web portal.** The level comes from `?space=`, or from the `crew_welcome` cookie set at the last sign-in. Chips let people switch level.
- **Console.** It has its own world.
- **Mobile.** `WelcomeHero` (Animated, native driver) uses the same worlds. It shows on sign-in and on the biometric unlock screen. The scene moves in a band at the bottom so it never covers the words. The last level is remembered on the device, and biometric sign-in is unchanged.

## Tests

- API: `apps/api/test/notification-framework.spec.ts`
- Contracts: `packages/contracts/src/notification-framework.spec.ts`
- End to end: `pnpm e2e:notifications-login`, on a fresh demo database with the web portal and Console running. Set `SHOTS=<dir>` to save screenshots.

## Working end to end

- Everything above on the web portal and Console, checked by the end-to-end flow.
- The phone screens are checked by typecheck and the mobile unit suite.

## Not yet verified

- Push, sound and haptics on a real iPhone or Android phone. Expo push needs a device build.
- Console notifications are left to PR #79 (`platform_notifications`).
