# Design refresh, part 7: the neon dashboard design

Source: the three design images Kunal shared on 2026-11-04 ("CREW HR CRM Neon Dashboard Showcase", the "Future HR,
AI driven dashboard" screen and the "HR CRM Cloud" Home with its Themes & Templates panel). The ask was to make this
the shared look of the Web Portal. This part builds it as a style of the existing theme engine, so every module,
preset, mode, contrast setting and the Classic look keep working.

## What was built

### Neon style (default) and backgrounds
- **Two new appearance fields**, saved per person with the rest of their appearance (`member_preferences`, no
  migration: older saved preferences read as the defaults):
  - `style`: `neon` (default) or `classic` (the previous flat look).
  - `backdrop`: `aurora` (default, mountain ridges), `cosmos` (stars), `gradient` (a colour wash) or `plain`.
- They are set as `data-style` and `data-backdrop` on `<html>`, so the first paint already has them.
- **What neon changes** (all in `@crew/ui/styles.css`, colours still come from the theme):
  - A deep night sidebar in every mode, with a gradient pill for the current page.
  - Frosted glass cards with a soft brand-tinted shadow, and gradient primary buttons.
  - A pill search field and a gradient CREW IQ button in the top bar.
  - Bigger page titles, and the chosen background behind the app.
  - A greeting chip ("Hi, name" and role) on wide screens, and an "Upgrade your plan" card in the sidebar for
    people who can see billing on a plan below Enterprise. It links to the real plans page.
- **Accessibility.** Text that sits directly on a background keeps the contrast the theme builder checks, because
  every background is built on the theme's own background colour.
  - High contrast and focus mode always use a plain background and solid cards.
  - KPI tile gradients use stops chosen for 4.5:1 or more against white text.
  - The sidebar's text colours are re-declared for its dark panel.
- **New preset: Cyber Neon** (magenta, violet and cyan). It passes the same WCAG checks as the other twelve.

### Themes & Templates panel
- Opened from the Themes button on Home, or from the theme menu in the top bar.
- **Themes tab**: theme styles (all 13 presets, drawn from their real palettes), colour palette, UI mode
  (Light, Dark, Auto), visual style (Neon, Classic) and background style.
- **Templates tab**: six ready-made looks, each a set of appearance fields:
  - Corporate Modern
  - Creative Gradient
  - Dark Elegant
  - Minimal Clean
  - Nature Fresh
  - Tech Futuristic
- **Layouts tab**: sidebar, density, corners and motion.
- **How saving works:**
  - Every pick previews on the live page at once.
  - **Apply theme** saves the changes in one update.
  - Closing without applying (the X, Escape or clicking outside) puts the saved look back.
- The Theme Studio (`/settings/appearance`) also has the new style and background settings.

### Module overviews (live data)
- **New endpoint:** `GET /dashboard/modules/:module`, for `employees`, `recruitment`, `attendance`, `leave`, `payroll`,
  `performance`, `learning` and `analytics`. It returns KPI tiles and charts computed from live records.
- **Access rules.** Each module needs its plan feature and a wider-than-own grant of the permission its list uses.
  - Every count uses that permission's scope predicate, the same rule as the list it links to. A department manager
    sees their department; HR sees the workspace.
  - People who can only see their own record get 403, and their pages look as before.
  - Payroll needs two-step verification, as on the payroll pages.
- **What each module shows:**
  - **Employees:** total (change vs 30 days ago), new this month, on leave today (only with leave access) and
    upcoming joiners. Charts: headcount trend over 6 months and a department donut.
  - **Recruitment:** active jobs, applications (new in 7 days), in screening, interviews in the next 14 days and open
    offers. Charts: pipeline by stage and applications per week.
  - **Attendance:** total, present, on leave, late and absent today.
    - A day "in progress" counts as present only after a punch in.
    - Charts: today's rate (ring), the last 7 days, and the latest check-ins.
  - **Leave:** requests, approved and rejected this month, and pending. Charts: days taken this year by leave type
    (in each type's own colour) and who is away in the next 14 days.
  - **Payroll:** net payroll for the latest month, employees paid, average net pay and on-time payment over 12
    months. Charts: net payroll over 6 months and a split of the latest run.
  - **Performance:** people in the current review cycle, reviewed, in progress and goals at risk. Charts: average
    goal progress and the rating distribution on the cycle's own scale.
  - **Learning:** active courses, enrolled learners, completion rate and overdue. Charts: completions per month and
    top courses.
  - **Analytics:** headcount, retention, attrition and average time to hire.
    - Charts: workforce by department, and "Key insights".
    - Key insights are plain statements computed from those numbers. They never claim more than the data shows.
- **Where they appear.** At the top of Employees, Recruitment, Attendance, Leave, Payroll, Reviews and Learning, and on
  a new **HR analytics** page (`/insights`, in the Analytics & AI menu).
  - Each overview ends with a quick action bar.
  - The bar shows only the actions the person is allowed to use.
- **Shared components** in `apps/web/components/neon.tsx`: KPI tile, line, bar, donut, ring and meter charts, item
  list and quick action bar. They are plain SVG and HTML, and every chart has a text alternative for screen readers.

### Home
- Greeting hero with the date and a Themes button.
- The KPIs are gradient tiles.
- Workforce overview: the headcount trend over 6 months.
- Department wise employees: a donut chart.
- Today's highlights: approvals, attendance exceptions, interviews and tasks, each with a link.
- Quick actions.
- A CREW IQ card that opens the assistant.
- The customisable widgets stay below, as before.
- The Home dashboard now shows payroll figures only with two-step verification, as on the payroll pages. Before this
  part it showed the last net payroll without it.

## Tests
- `packages/contracts`: the 13 presets pass WCAG AA in light and dark, at standard and high contrast. The new fields
  default correctly, and old saved preferences still read. Templates and palette swatches are valid updates.
- `apps/api/test/experience.spec.ts`: module overviews for HR (whole workspace) and a department manager (their
  department only). An employee gets 403. Another workspace is never counted. Every module answers. An unknown module
  is refused. Style and background save and validate.
- `e2e/neon-flow.cjs` (`pnpm e2e:neon`, in CI after `e2e:experience`):
  - The neon shell and Home charts appear.
  - Each module overview shows the same numbers the API computes for that person.
  - The panel previews a look, and closing it puts the saved look back.
  - A background, colour and template are applied, persist after a reload, and Classic really turns the neon look off.
  - An employee gets no workspace overview.
- `e2e/a11y.cjs` now also checks Employees, HR analytics, Reviews and Learning (with overviews) for an HR user.

## Not yet
- The mobile app reads the same theme preset and colours but does not draw the neon backgrounds or gradient tiles.
- The design images show an "Onboarding" module and a "Reports" builder (custom and scheduled reports). They are not
  built here. Onboarding checklists already exist under Settings. Scheduled reports would be a separate feature.
- The design images show photos and illustrations (mountain photograph, robot, trophy). CREW draws its own vector
  ridges and icons instead, so nothing is copied and pages stay light.
