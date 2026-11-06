# 11. UI/UX Design System

The design system lives in `packages/ui` (`@crew/ui`) and is consumed by the web portal, the Super Admin Console and (as tokens) the mobile app.

## 11.1 Identity

- **Personality:** calm, confident, precise. SampCrew handles payroll and people's livelihoods, so the interface should feel trustworthy rather than playful, with warmth coming from typography, spacing and small moments of delight.
- **Signature colour:** *SampCrew Indigo* (`#4F46E5` family) for primary actions, paired with a warm *Ember* accent (`#F97316` family) used sparingly for highlights and AI moments.
- **Typeface:** Inter (UI) with tabular numerals enabled for every number column; JetBrains Mono for IDs and codes.

## 11.2 Tokens

All tokens are CSS custom properties on `:root`, redefined under `[data-theme="dark"]` and `prefers-color-scheme: dark`. Tenants can override the brand hue for their workspace; contrast is re-checked automatically and the override is rejected if text fails WCAG AA.

| Group | Tokens |
|---|---|
| Surface | `--bg`, `--bg-subtle`, `--surface`, `--surface-raised`, `--overlay` |
| Text | `--fg`, `--fg-muted`, `--fg-subtle`, `--fg-on-accent` |
| Lines | `--border`, `--border-strong`, `--ring` |
| Brand | `--accent`, `--accent-hover`, `--accent-subtle`, `--ember` |
| Status | `--success`, `--warning`, `--danger`, `--info` (+ `-subtle` backgrounds) |
| Data viz | `--chart-1` … `--chart-8` (categorical, colour-blind-safe order), sequential and diverging ramps |
| Radius | `--radius-sm 6px`, `--radius-md 10px`, `--radius-lg 14px`, `--radius-xl 20px` |
| Elevation | `--shadow-sm`, `--shadow-md`, `--shadow-lg` (soft, low-opacity, tinted by surface) |
| Motion | `--ease-out: cubic-bezier(.16,1,.3,1)`, durations 120/200/320 ms; all motion disabled under `prefers-reduced-motion` |
| Spacing | 4 px base scale (Tailwind default) |
| Type scale | 12 / 13 / 14 (body) / 16 / 20 / 24 / 30 / 36 |

## 11.3 Components (Phase 1 set)

Button (primary, secondary, ghost, danger; sizes; loading), Input, Textarea, Select, Checkbox, Switch, Label + FormField with error text, Card (with header/action slots), Badge/StatusPill, Avatar, Table (sortable header, empty and loading states), Tabs, Dialog, Drawer, DropdownMenu, Tooltip, Toast, EmptyState with illustration slot, Skeleton, Stat/KPI tile, Sidebar navigation, TopBar, CommandPalette, PageHeader, DemoDataBanner.

Later phases add: DataGrid with virtualisation and column config, Kanban board (pipeline), Calendar/roster grid, Heatmap, Timeline, File dropzone, Signature pad, Rich-text editor, Workflow canvas.

## 11.4 Layout patterns

- **App shell:** collapsible left sidebar (module groups), top bar (tenant switcher, global search, command palette trigger, notifications, AI, profile). Content max width 1440 px with 24-32 px gutters; 16 px gutters on phones.
- **Record page:** header with identity + status + primary actions, tabbed body, right rail for context (activity, AI insights).
- **List page:** filter bar with saved views, table that turns into cards below 768 px, bulk action bar on selection.
- **Dashboards:** 12-column responsive grid of widgets; widgets are draggable and resizable on desktop, stacked on mobile.

Avoid: heavy borders around everything, dense multi-column forms, modal stacks. Prefer: whitespace, progressive disclosure, inline editing, side drawers for quick views.

## 11.5 Content and states

Every screen designs five states: loading (skeletons, not spinners), empty (explains what will appear and the first action), partial, error (what happened + retry + support id), and success. Demo data is always marked with a visible "Demo data" banner. Integrations show "Not connected", "Simulated" or "Connected", never a fake green tick.

## 11.6 Accessibility

WCAG 2.2 AA: 4.5:1 text contrast, visible focus rings (`--ring`), full keyboard support, `aria-live` for toasts, labelled form controls, no information by colour alone (status pills include icon or text), minimum 44×44 px touch targets in mobile layouts.
