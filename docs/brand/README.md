# SampCrew brand files

SampCrew ("People, simplified." by SAMPLEDGE) is the product name from 6 November 2026. It was called CREW before.
The artwork here is SAMPLEDGE's own; copies live where each app serves them.

| File | What it is | Where it is used |
| --- | --- | --- |
| `sampcrew-icon.svg` | The mark alone (three people gathering), animated | Web Portal and Console: collapsed menu (`public/brand/`) |
| `sampcrew-icon-static.svg` | The same mark without animation | Browser tab icon (`public/icon.svg`) |
| `sampcrew-icon-512.png` | The mark as a 512 px picture | Source for app icons |
| `sampcrew-wordmark-light.svg` / `-dark.svg` | Mark and the word SampCrew, without the tagline (made from the full logo) | Menus and headers (`CrewLogo`) |
| `sampcrew-logo-light.svg` / `-dark.svg` | Full logo with "People, simplified. \| by SAMPLEDGE", animated | Sign-in pages, page not found |
| `sampcrew-logo-light.png` / `-dark.png` | Full logo at 6x | Mobile app sign-in (`apps/mobile/assets/logo-*.png`) |

"light" artwork is drawn for light backgrounds and "dark" for dark ones. `CrewLogo` in `packages/ui` shows the one
that matches the current theme, or a fixed one with `tone="light"` or `tone="dark"`.

Mobile app (`apps/mobile/assets`, set in `app.config.ts`):

- `icon.png`: 1024 x 1024, the mark on white (iOS does not allow a transparent icon).
- `adaptive-icon.png`: the mark on transparent, inside Android's safe zone, on a white background.
- `splash-icon.png`: the mark for the launch screen (white, or #0B1020 in dark mode), through `expo-splash-screen`.
- `favicon.png`: tab icon for the browser build.

The PNG icons are drawn from `sampcrew-icon-static.svg`. To redraw them after the artwork changes, open the static SVG
at the needed size in a browser and save a screenshot with a transparent background (or white for `icon.png` and
`apple-touch-icon.png`).

## What did not change

Internal names stay as they were, so nothing already deployed or installed breaks: package names (`@crew/*`),
environment variables (`CREW_*`), database names, the mobile app's bundle id (`com.sampledge.crew`) and its link
scheme (`crew://`, which single sign-on redirects use), device API tokens (`crewdev_`), and old database migrations.
Authenticator apps keep showing the old name for codes set up before the change; new set-ups show SampCrew.
