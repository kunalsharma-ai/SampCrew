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

### Greeting, sign-in box, themes and feedback

- **Greeting.** A waving hand, "Good morning / afternoon / evening" by the browser's clock, and a rotating "Hello, Namaste, Marhaba, Bonjour, Hola, Vanakkam". The Console adds "SAMPLEDGE team" and a "SAMPLEDGE staff only" badge. The workspace name is bold and large; the end-to-end flow checks that the greeting, name and words never overlap the picture (1440 and 1280 px wide).
- **Sign-in box.** A glass card with a rotating colour border, the level's badge and name in bold, a Secure (or Staff only) chip, email and lock icons in the boxes and a trust strip (multi-factor, encrypted, audited).
- **Light, dark and palettes.** Sun and moon buttons (Auto, Light, Dark) and "Colours" (Signature, Aurora, Sunset, Ocean, Forest, Candy, Graphite). Kept per device in `localStorage` (`crew-signin-theme`). The phone sign-in has the same choice under its hero (kept on the phone under the same key) and the same greeting (`SignInGreeting`, `SignInThemeBar`, `signInWorld` in `apps/mobile/src/lib/signin-theme.ts`). The workspace name on the phone is sized to stay on one line.
- **Eye button.** `PasswordInput` in `@crew/ui` on every password box: sign-in, reset, change password, sign-up, invitations, Console setup. The phone `Field` shows one on every hidden field.
- **Forgot password.** A link under the password on the web portal, the Console and the phone app, and on an invitation for an existing account.
- **Validation and feedback.** The email gets a green tick once it is a complete address and a red cross with a plain message when it is not. A new password shows its rules ticking off and a strength bar; a confirmation shows whether it matches. A wrong password draws a red cross in the box, turns the card border red and shakes it; a right one draws ticks, turns the border green and plays a "Signed in" burst.
- **Welcome after sign-in.** `WelcomeIntro` plays once per sign-in (flag in `sessionStorage`, set by the sign-in form) over the dashboard while it loads: the level's colours, rings, sparks, the person's first name in big letters, "Welcome to your **HR Workspace** at **Company**", a progress line, then two curtains open. Click, Enter or Escape skips it; reduced motion shows a short still card. The phone plays its own version after a real sign-in (not when the app opens with a saved session).

## Public Help & Support

- **Where.** `/help-and-support` on the web portal, open before signing in, from the "Help & Support" button at the top of every sign-in page. Article pages at `/help-and-support/<slug>`.
- **What it shows.** A hero with search across everything, popular searches, topics, "Our features" (a brief per module), "What we offer" (offerings, facilities and support, security), FAQs by topic, step-by-step guides and a "Still need help?" band (sign in and raise a query, or forgot password).
- **Content.** The help centre from PR #74, extended: audience `public` ("Everyone (public Help & Support)") and two new kinds, `feature` (Feature brief) and `article`, plus an optional card `icon`. Signed-in people see public content in their own help centre too. The built-in library adds 5 public categories, 14 feature briefs, 5 articles, 14 FAQs and 2 guides.
- **API.** `GET /public/help`, `GET /public/help/search`, `GET /public/help/articles/:slug`. No sign-in, rate limited, read-only. Only published content with the public audience and no feature or permission is returned.
- **Managed by Super Admin.** Console > Help content: "New feature brief" and "New public FAQ" open the editor with the kind and the public audience chosen; any article can be made public with the "Everyone" level. A feature brief or article needs its text.

## Tests

- API: `apps/api/test/notification-framework.spec.ts`, and the public Help & Support tests in `apps/api/test/help-centre.spec.ts`
- Contracts: `packages/contracts/src/notification-framework.spec.ts`
- End to end: `pnpm e2e:notifications-login`, on a fresh demo database with the web portal and Console running. Set `SHOTS=<dir>` to save screenshots.

## Working end to end

- Everything above on the web portal and Console, checked by the end-to-end flow: no overlap, theme choice kept after reload, email check, eye button, wrong password cross and shake, Forgot password link, tick and burst then the welcome after sign-in, the public Help & Support page with search and an article.
- The phone screens (eye button, tick and cross, greeting, light/dark and palettes, welcome after sign-in) are checked by typecheck, the mobile unit suite (`signin-theme.spec.ts`) and screenshots of the web build only.

## Not yet verified

- Push, sound and haptics on a real iPhone or Android phone. Expo push needs a device build.
- Console notifications are left to PR #79 (`platform_notifications`).
