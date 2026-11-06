# In-app help ("i" icons)

Every page, sidebar group, card heading and key form field in SampCrew can show a small "i" icon. Hover, tap or
click it (or press Enter on it) to read three short parts: **What it is for**, **How to use it** and **Where and when**.

## Where the words live

One file per app. Change the text there; no other code needs to change.

| App | File | How an item finds its help |
| --- | --- | --- |
| Web Portal | `apps/web/lib/help-content.ts` | Pages by route, sidebar groups by label, card headings and form fields by their visible text |
| Super Admin Console | `apps/console/lib/help-content.ts` | Same as the Web Portal |
| Mobile app | `apps/mobile/src/lib/help.ts` | By key: screens in their header (`screenHelp('leave')`), cards and fields with `help="leave.balances"` |

In the Web Portal and Console:

- `pages` is keyed by route, for example `'/employees/[id]'` (`[id]` matches any id).
- `sections` and `fields` are keyed by the heading or label exactly as shown on screen. One entry serves every page
  that shows that heading or label.
- When a heading or label means something different on one page (for example "Status"), add it under
  `routes['/that/page']`; that entry wins on that page only.
- A heading or label with no entry shows no icon. To hide an icon on purpose, pass `help={false}` to `PageHeader`,
  `CardHeader` or `Field`; to give one-off text, pass `help={{ what: '…' }}`.

Keep each part to one or two short sentences, and use the SampCrew name.

## Checks

- `pnpm test` fails if a Web Portal or Console page, a sidebar group or a card heading has no help, if help points
  at a page that no longer exists, if any text is too long or still says CREW, or if a mobile screen with a header
  has no "i" icon.
- `pnpm e2e:help` drives the icons in a real browser: mouse hover and click, touch, keyboard (Enter, Space, Escape,
  Tab), help inside a modal form, a phone-sized screen, the Console and the mobile app, and runs axe on the open help
  in neon and classic, light and dark.

## Accessibility

- The icon is a real button named "More about this page" (or section, field, module), described by the heading or
  label next to it. It does not repeat the label in its name, so a label, a voice command or a test that names a
  control still finds exactly one control.
- The help opens in the browser's popover top layer, so it shows above cards, scroll areas and modal dialogs, and it
  stays right after the icon in reading order. Keyboard users land inside it; Escape closes only the help.
- On the mobile app the help opens as a sheet with a Got it button; tapping outside or the back gesture closes it.
