# Design refresh, part 1: design foundation, shell and Home

Source: "CREW front end design" (the Adaptive Human Intelligence OS master prompt). That document asks for a
lot more than one change can carry, so it is being delivered in parts. This part covers its "Phase 1, design
foundation" and the parts of "Phase 2, core application" that every screen depends on: theme tokens, the
application shell, navigation, search and quick actions, and the executive Home dashboard. Every one of the
existing 90 Web Portal screens picks up the new look through the shared tokens; their workflows are unchanged.

## What was built

### Theme engine (`packages/contracts/src/experience.ts`)
- Twelve presets: Midnight Intelligence (default), Aurora Glass, Executive Pearl, Graphite Elite, Oceanic
  Intelligence, Emerald Command, Royal Amethyst, Sunset Fusion, Arctic Frost, Copper Executive, Rose Quartz,
  Monochrome Precision. Each has a light and a dark palette; "system" follows the device.
- Palettes are generated from a few seed colours into semantic tokens (`--bg`, `--surface`, `--fg-muted`,
  `--accent`, `--chart-1..5`, glows). A person's own primary, secondary and accent colours are adjusted, not
  refused, until text and buttons reach WCAG AA. Unit tests check every preset in both modes at standard and high
  contrast (48 combinations) plus awkward custom colours.
- Non-colour preferences: density (scales Tailwind's spacing unit, so every screen follows), text size (all text
  sizes are now rem), corners, contrast, table row density, chart palette (theme, colour-blind safe, single
  colour), motion (Cinematic adds slow ambient light; Balanced keeps 120 to 250 ms transitions; Focus removes
  animation), Focus mode (no ambient light, glass or animation), sidebar expanded or icons only, glass or solid.
  The operating system's reduce-motion setting always wins.
- The same builder is exported for the mobile app (not wired into the app yet, see below).

### Saved per person (`member_preferences`, migration 0011)
- One row per membership: appearance, favourites (up to 12 in-app paths), the last 8 pages visited, Home layout,
  personal notes. Row-level security keeps it inside the workspace; the API only ever reads and writes the
  caller's own row. Endpoints under `/me/preferences`.
- The first paint is right: the root layout renders the theme from a cookie copy; the shell rewrites the cookie
  when the database copy differs (for example after changing the theme on another device).

### Shell (`apps/web/app/(app)/shell.tsx`)
- Sidebar grouped by HR module (Employee management, Recruitment & ATS, Attendance & time, Payroll,
  Performance & learning, Engagement & relations, Analytics & AI, Compliance, Administration), collapsible
  groups, a filter box, favourites (star any page), live approval counter, collapse to an icon rail (Ctrl+B).
- Top bar: search, Create menu (opens the real create form on the target page), approval inbox with count,
  tasks, leave calendar, notifications, theme menu (mode, presets, Focus mode, link to the Theme Studio).
- Ctrl+K palette: actions, people (employees and candidates, each with its own permission checks), recently
  viewed pages, every page, and appearance commands ("Theme: Aurora Glass", "Turn focus mode on"). Ctrl+. toggles
  Focus mode.

### Home (`GET /dashboard`, `apps/web/app/(app)/home-dashboard.tsx`)
- KPI strip: total and active employees (with a six-month trend), new hires, attrition rate (last 12 months),
  open positions, recruitment pipeline, attendance today, pending approvals, last payroll. Each figure uses the
  same scope rules as the list it links to: HR sees the workspace, a manager sees their team, an employee sees
  no workspace figures at all.
- "Needs your attention": approvals (approve or reject right there), interviews you are on in the next 7 days,
  onboarding tasks assigned to you, probation ending in 30 days, payroll runs waiting for the preparer.
- Workforce at a glance (headcount by department, pipeline by stage, attendance today), my tasks, recently
  viewed, quick actions, personal notes (autosave), Ask HR, workspace setup, your access.
- Customize: drag widgets (or use the arrow buttons), hide widgets, save; stored per person.

### Theme Studio (`/settings/appearance`)
Every preset previews itself in its own colours; all settings above; reset to default.

## Working end to end
- Theme, colours, density, motion and Focus mode: saved to PostgreSQL, applied without a reload, kept after a
  reload and in a second browser (browser test `e2e/experience-flow.cjs`).
- Favourites, recent pages, Home layout and notes: saved and restored (API tests and browser test).
- One-click approval from Home: an operator requests leave from the Create menu, the supervisor approves it on
  Home, it leaves the approval inbox (browser test).
- Palette people search and theme commands (browser test).
- Dashboard scoping for HR, manager, employee and another workspace (API tests `experience.spec.ts`).
- All earlier browser flows (Web Portal, Core HR, talent, helpdesk, attendance, payroll, mobile, recruitment,
  AI, integrations, enterprise, console) were run against the redesign.

## Not yet (later parts of the design document)
- Enterprise table system (column pinning, resizing, saved views, virtualised rows, XLSX export).
- Seven-step add-employee wizard with save-and-resume and bulk import; Employee 360 workspace layout.
- ATS kanban, calendar, timeline and comparison views; staffing bid / requisition proposals with margin
  maths and PDF preview (needs new backend module).
- Payroll Review → Validate → Resolve → Approve → Process stepper; attendance heatmaps and calendars.
- CREW IQ side panel (today's AI answers HR policy questions on Ask HR only) and the optional 3D Workforce
  Universe.
- Mobile app theming from the saved preference, language selector and right-to-left layouts.
- Document expiry and contract renewal alerts in "Needs your attention" (no expiry dates are stored yet).
- Core Web Vitals have not been measured on this change; the dashboard adds one API call per Home load.
