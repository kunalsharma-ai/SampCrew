# Design refresh, part 8: neon mobile app, and survey, feedback and compare pages that explain themselves

Part 7 gave the Web Portal the neon design. This part brings the same look to the CREW mobile app, and fixes three
Web Portal pages that showed "page not found" when opened directly.

## Neon mobile app

The app reads the same saved appearance as the Web Portal (`member_preferences`), so the visual style, background,
preset, mode, corners and contrast chosen on either one apply to both. No migration or API change was needed.

### What changes in the neon style (the default)
- **Theme** (`src/lib/theme.ts`): the palette gains `neon`, `backdrop`, `glass`, `gradient`, `glow` and `radius`.
  - Neon is off for the Classic style, high contrast and focus mode, as on the web.
  - The primary gradient runs from the accent to a mix of accent and the secondary colour. The far stop is pushed
    until button text reads at 4.5:1, and a unit test checks this for every preset, both modes and custom colours.
  - KPI tiles use the Web Portal's six gradient pairs. White text reads at 4.5:1 or more on every stop (tested).
- **Shared components** (`src/ui/index.tsx`):
  - Glass cards with a brand-tinted border and soft glow, and corners from the member's corner setting.
  - Gradient primary buttons with a glow, and gradient chips for the selected choice.
  - New: `Hero` (workspace eyebrow, greeting, role chip), `Tile` and `TileGrid` (KPI tiles), `Meter` (progress bar),
    `QuickActions` (round shortcuts), `Avatar` and `CardTitle` (heading with a brand bar).
  - Gradients and glows use React Native's `experimental_backgroundImage` and `boxShadow` (new architecture), and CSS
    on the web build. A solid colour sits underneath, so text stays readable where a gradient cannot be drawn.
- **Backgrounds** behind every screen, built on the theme's own background colour: Aurora (soft ridges across the
  top), Cosmos (a star field and two glows), Gradient (a colour wash) or Plain.
- **Tab bar**: a night panel in every mode, like the Web Portal's sidebar, with the current tab in a gradient pill.
  Its text colours are checked at 7:1 and 4.5:1 (tested).

### Screens
- **Home**: a greeting for the time of day in the workspace's time zone, with the person's role.
  - Four KPI tiles from live records: today's attendance status (or punch state), approvals waiting, leave
    available across tracked leave types, and unread notifications. Each opens its screen.
  - Quick actions: punch, apply for leave, ask HR and approvals, shown only when the person can use them.
- **Attendance**: tiles for time worked today and punches (including punches still saved on the phone).
- **Leave**: tiles for days available and requests waiting, and each balance as a bar in its leave type's colour.
- **Payslip**: net pay as a tile above the breakdown.
- **Me**: an avatar header, and three new appearance settings saved to the account:
  - **Templates**: the six ready-made looks from the Web Portal's Themes panel.
  - **Visual style**: Neon or Classic.
  - **Background**: Aurora, Cosmos, Gradient or Plain (neon only).
- **Sign in**: the CREW mark in the brand gradient.
- Day status "in_progress" now reads "In progress" (it showed the raw value before).

## Pages that showed "page not found"

The three pages were not broken; they are personal or need a selection, and anyone else got a bare 404.

| Page | Who it is for | Before | Now |
| --- | --- | --- | --- |
| Survey response (`/surveys/:id`) | Invited employees | 404 for anyone not invited | People who run surveys go to its results page; others see "This survey is not open to you" with a link to their surveys |
| Give feedback (`/reviews/feedback/:id`) | The colleague asked | 404 for anyone else | "This feedback request was sent to someone else", explaining that managers and HR read it on the review |
| Compare candidates (`/recruitment/jobs/:id/compare`) | Recruiters, with 2 to 4 candidates picked | 404 without `?applications=` | The job's header and "Pick candidates to compare", linking to the pipeline; a bad pick says so |

Nothing new is revealed: the survey and feedback contents still come only from endpoints that check the caller, and
the redirect to survey results only happens when the results endpoint (needs `engagement:manage`) answers.

## Tests
- `apps/mobile`: 4 new unit tests (neon switch, gradient contrast in every preset and mode, tile and tab bar
  contrast, alpha colours).
- `e2e:mobile`: Home tiles match the API's approvals, unread notifications and leave available; a template, a
  background and the Classic style are saved to the account. The greeting checks follow the new wording.
- `e2e:talent` and `e2e:ats`: the three pages opened directly by someone who is not the addressee, or without a pick.

## Not yet
- The app is tested through its browser build, as before, not on real phones. Gradients need the new architecture,
  which Expo 57 always uses.
- Charts (donut, line) from the web's module overviews are not on the phone; the app shows tiles and bars only.
