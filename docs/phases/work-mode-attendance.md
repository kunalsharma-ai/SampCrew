# Smart attendance: Work From Office, Work From Home and hybrid

Kunal's 25 November 2026 specification ("SampCrew – Smart Attendance Management, Geolocation Verification & Workforce
Visibility"). Every attendance day is classified automatically as **Work From Office**, **Work From Home** or
**Work From Office + Home** (hybrid) from where the person checked in and out. Super Workspace and HR Workspace get an
organisation-wide view with an 8-sheet Excel report. The work builds on the attendance overview of PR #64.

## How a day is classified

- **Where each punch was** (`resolveZone`, `packages/contracts/src/work-mode.ts`):
  - A reading inside an office geofence counts as office. The geofences are the company's locations with a latitude,
    longitude and radius.
  - A reading inside an approved work site counts as office or remote, whichever the site is set to.
  - A reading outside every place counts as remote.
  - **No reading, a refused permission, a timeout, a mock location or a reading too vague to decide is `unverified`.**
    It is never counted as home.
  - A vague reading is still decided when its accuracy circle lies fully inside or fully outside a geofence.
  - Kiosk (QR) and device punches count as office. Correction and import punches take the zone of the other end of
    their interval.
- **The day** (`classifyWorkMode`), run inside every day recompute (`AttendanceDaysService.setClassifier`):
  - In and out at the office is office. In and out away from the office is remote.
  - In at the office and out elsewhere is hybrid. The time between two readings in different places is split by the
    rule: half and half (the default), where the check-in was, or where the check-out was.
  - **Update my location** readings during the day make the split exact.
  - Hybrid needs both minimums (default 60 minutes at the office and 60 minutes away). Below that the larger side wins,
    so a lunch outside does not make the day hybrid.
  - Any unverified time makes the day **Pending verification**. The best answer from verified time is kept as a
    guess for HR.
  - A day still open is provisional and counts up to now. A missing check-out after the day is flagged and not counted.
  - Approved work from home with no punches counts as remote.
- **HR corrections win.** An HR verification or an approved correction is stored on the day and survives every
  recompute. Every change (automatic, HR or correction) is a row in the append-only `work_mode_changes`, shown as the
  day's history, and goes into the audit trail.
- **Existing days are left as they were.** Classification starts on the day the migration runs (`classify_from`).
  Switching it off and on again restarts from that day.

## Privacy

- The location is read only when the person presses Check in, Check out or Update my location. It is never tracked
  in the background, on the web or in the mobile app.
- Coordinates are stored apart from the append-only punches, in `attendance_locations`. The hourly HR job removes them
  after the retention period (default 90 days; 0 keeps them). The office or home result stays.
- Exact coordinates are shown only to the person and to people with `attendance:configure`. The report adds coordinate
  columns only for them.

## Screens

- **Employee attendance** (`/attendance`):
  - An animated status card, for example "You're Working From Office today", with a prominent Check in / Check out
    button and Update my location.
  - Office and away hours, how the day was worked out, and the person's offices.
  - "Where you worked this month" counts and a Where column in the month view.
  - Corrections by category (forgot to check in or out, technical issue, location issue, worked elsewhere, other).
    A correction can add punches, change where the day counts, or both. Rejecting one needs a reason.
  - Attendance notice choices.
- **Workforce attendance** (`/attendance/work-mode`, Super Workspace and HR Workspace):
  - Clickable cards: total, present, office, home, hybrid, pending verification, not checked in, on leave, incomplete
    and irregularities.
  - An animated donut, a stacked daily trend, and breakdowns by workspace level, department and office.
  - Filters for date, employee, department, designation, office, HR Workspace and level.
  - The people behind each card.
- **Office and home register** (`/attendance/work-mode/register`):
  - One row per person and day with check-in and check-out places, office and away hours, and issues.
  - Filters for category, status and location check.
  - Verify or correct a day with a reason. You can never do this for your own day.
- **Office locations** (`/attendance/offices`):
  - An interactive map: drag, zoom, and click to place the office.
  - Radius, use-my-location, approved sites, and who may check in where, including a per-person office rule.
  - Tiles come through the web app (`/map-tiles/z/x/y`, OpenStreetMap, cached a week), so the page keeps its
    images-from-self policy. When tiles cannot load, a grid remains and clicking still sets the point.
- **Rules** (`/attendance/work-mode/settings`):
  - Names (Super Workspace only), the minimums, the transition rule, other offices, the accuracy needed, and the
    standard day.
  - Where people may check in (anywhere, check-in at an office, or check-in and check-out at an office), whether
    employees may ask to change where a day counts, and location retention.
- **Day detail** (`/attendance/day/:employee/:date`): the result, the place and check of each punch and location update,
  and the full history.
- **Mobile app**: a "where today counts" card with office and away hours, Update my location, and the location status
  sent with each punch (also when queued offline).

## Levels

- **Super Workspace** sees everyone and can rename the three names.
- **HR Workspace** totals count the whole organisation (Super Workspace and other HR Workspaces included) while
  `attendance.org_totals` is on (the default). Its lists, register and report hold only the people its access covers.
  The Super Workspace can switch org totals off per HR Workspace in Attendance permissions.
- **Employee Workspace** sees and exports its own attendance only. The dashboard and register send it back to
  `/attendance`.
- The spec's "Manager" and "Executive" map to HR Workspace and Employee Workspace.

## Real time and notices

- Every check-in, check-out, location update, verification and correction sends `attendance.changed`. The attendance,
  dashboard and register pages refresh on it.
- Each person chooses their notices:
  - check-in and check-out recorded (off by default),
  - work arrangement changed,
  - location not verified,
  - missing check-out (the next morning, once),
  - for Super Workspace and HR Workspace, days waiting for verification.
- Correction decisions use the approval notices.

## Excel and CSV report

- `GET /attendance/work-mode/report` returns the **Report** button on the dashboard and register.
- Scope:
  - the view on screen, everything you may see, or chosen employees or categories;
  - the range as on screen, a custom range, or full history (up to 10 years and 250,000 day rows).
- Sheets:
  - Attendance Summary
  - Detailed Register
  - Office Attendance
  - Work From Home
  - Hybrid Attendance
  - Check-In and Check-Out Log
  - Exceptions & Corrections
  - Employee Summary
- Formatting: title rows (organisation, title, period, generated), a bold header, the header frozen, an auto filter,
  and real Excel dates, times and hours. Empty sheets are listed in the summary instead of added.
- CSV holds the detailed register.
- Filters can be saved per person. Every export is audited as `attendance.report_exported`.

## Data

- Migration `0190_work_mode_attendance`:
  - a `work_mode_settings` row per workspace;
  - defaults on existing days, locations and corrections.
- New collections:
  - `work_mode_settings`
  - `work_sites`
  - `work_assignments`
  - `attendance_locations`
  - `work_mode_changes` (append-only)
  - `attendance_saved_reports`
- New fields:
  - on `attendance_days`: the classification;
  - on `attendance_events`: the zone, the check result and the place;
  - on `attendance_corrections`: the category, the requested work mode and the decision reason;
  - on `locations`: `geofence_active`;
  - on `member_preferences`: `attendance_notices`.
- The demo workspace's last month has office, home and hybrid days.

## Tests

- `packages/contracts/src/work-mode.spec.ts`: 16 tests covering zones, classification, the rules, labels and settings.
- `apps/api/test/work-mode.spec.ts`: 10 tests covering:
  - geofences and sites;
  - renaming (Super Workspace only);
  - live check-ins and Pending verification;
  - hybrid splits;
  - HR verification and history;
  - corrections with a work mode;
  - dashboards and what each level sees;
  - the report and CSV with saved filters;
  - notices;
  - coordinate retention.
- `e2e/work-mode-flow.cjs` (`pnpm e2e:work-mode`, its own CI step on a fresh demo):
  - map and geofence edit, renaming;
  - office, home and refused-location check-ins;
  - the dashboard, register verification and report download;
  - the HR Workspace and Employee Workspace views.
