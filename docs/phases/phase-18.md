# Phase 18 report: email signatures for Outlook

Kunal asked (6 November 2026) for 20 signature designs that each person can pick, customise and apply to Outlook. This phase builds that inside SampCrew, with a small Windows sync that writes the signature into desktop Outlook and keeps it up to date, automatically or when the person chooses.

## Working end to end

Each item below runs against the real API and PostgreSQL (migration `0025_email_signatures.sql`). API tests: `apps/api/test/signatures.spec.ts` (10). Renderer tests: `packages/contracts/src/signatures.spec.ts` (25). Browser flow: `e2e/signature-flow.cjs` (`pnpm e2e:signature`, in CI after e2e:setup).

### 20 designs, one renderer
- `packages/contracts/src/signatures.ts` holds the 20 designs: Classic, Photo left, One line, Logo on top, Banner, Minimal, Bold name, Logo and divider, Business card, Centred, Two columns, Executive, Accent border, Photo on top, Labelled, Footer band, Social first, Call to action, With disclaimer, Warm sign-off.
- The same renderer draws the gallery, the live preview and the file Outlook gets, so the preview is exactly what is sent.
- The markup is safe for Outlook: tables and inline styles only, every image has a width and height, there is no SVG, no flex and no CSS classes. The .htm is written as UTF-8 with a byte order mark and the .txt as UTF-16, which is how Outlook reads them.
- Everything people type is escaped. Only http, https, mailto and tel links are kept.
- `composeSignatureData` applies the person's choices over the HR and company record. The web preview and the API both use it.

### Employee: Settings, Email signature (`/settings/signature`)
- The gallery shows all 20 designs with the person's own details.
- They can change colours, font, text size, which details to show, job title, pronouns, phones, tagline, sign-off, button text and link, and their own social links.
- The preview updates as they type. A half-typed colour or link is flagged and the preview keeps the last valid version.
- They can choose automatic or manual sync if the company allows it.
- "Download setup file" connects a computer and downloads `SampCrew-Outlook-Signature-Setup.cmd`. If there are unsaved changes, it saves first.
- Each computer is listed with its status (waiting, up to date, update pending or failed), its Windows name, Outlook version and last check. It can be disconnected.
- "Sync my computers" makes every computer install the signature again at its next check.

### Admin: Administration, Email signatures (`/settings/signature/company`, `org:manage`)
- Company name, website, phone, address, colours, disclaimer and social links.
- A PNG or JPEG logo up to 1 MB. Its real width and height are read from the file so Outlook keeps the proportions.
- The starting design, with an option to lock it for everyone.
- Company sync mode, and whether people can choose their own.
- An overview of everyone's design, sync mode and computers, with a disconnect button per computer.

### The Windows sync (`apps/api/src/modules/signatures/installer.ts`)
- The setup file is one `.cmd` that runs Windows PowerShell. It needs no administrator rights.
- It copies itself to `%LOCALAPPDATA%\SampCrew\Signature`.
- It asks SampCrew for the signature (`POST /signature-agent/sync`), downloads the photo and logo, and writes `SampCrew.htm`, `SampCrew.txt` and `SampCrew_files` into `%APPDATA%\Microsoft\Signatures`.
- It makes the signature Outlook's default for new messages and replies. This works for Outlook 2010, 2013 and 2016 or later, for every mail profile and account.
- It reports success or the error back to SampCrew (`POST /signature-agent/report`).
- Automatic mode runs a scheduled task every 30 minutes. Manual mode uses only the "Sync SampCrew signature" shortcut on the desktop. The mode is read from SampCrew on every run, so a change made in SampCrew reaches the computer at its next sync.
- Each computer has its own token (`scsig_…`), stored in the database only as a SHA-256 hash.
- The token stops working when the computer is disconnected or the employee leaves. The computer then removes its scheduled task and shortcut and tells the person.
- The three `/signature-agent` routes are public, so the computer can reach them without a session. They are throttled and listed in `REVIEWED_PUBLIC`.

## Not yet working
- **The setup file has not been run on a real Windows PC with Outlook.** The sandbox has no Windows or PowerShell. The browser flow downloads the real file and then calls the API exactly as the script does. Please run it once on a Windows PC with Outlook 2013 and once with Outlook 2016/365 before rolling it out.
- Windows SmartScreen may warn about the downloaded `.cmd` because it is not code-signed. Signing needs a code-signing certificate, which only SAMPLEDGE can buy.
- Only Windows desktop Outlook is covered. Outlook on the web, Outlook for Mac and the new Outlook for Windows store signatures in the cloud. Supporting them needs Microsoft 365 admin consent (Graph or a transport rule), which is not built.
- The photo is shown square, as uploaded. There is no cropping tool.
- WebP photos are left out of the Outlook signature because Outlook 2013 cannot show them. The page tells the person to upload a PNG or JPEG.
- "Sync my computers" reaches an automatic-mode computer within 30 minutes. A manual-mode computer updates when its person clicks the desktop shortcut.
