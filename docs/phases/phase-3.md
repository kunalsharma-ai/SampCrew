# Phase 3 report: Attendance and Workforce

Status: complete, pending product owner review.
Date: 2026-10-31.

## What was delivered

### Raw punches and derived days
- Every punch is stored once in `attendance_events`, exactly as received, and is never changed or deleted. A database trigger refuses updates and deletes, and the API login has no grant to do either.
- Punches are deduplicated by `(workspace, source, source event id)`. A retried web request, a phone syncing late or a device resending the same record is stored once.
- `attendance_days` is derived data. It is rebuilt from the raw punches by the attendance engine and is never edited by hand.
- A correction does not touch the original punches. When it is approved, the requested punches are added with source `correction`, linked to the request, and the day is recalculated.

### The attendance engine
The engine (`packages/contracts/src/attendance-engine.ts`) is a pure function that takes one employee-day (shift, calendar, leave, punches, time zone) and returns the status, minutes and a plain-language explanation of every decision. The day detail screen shows that explanation, so anyone can see why a day was counted the way it was.

Rules, all covered by golden tests:
- **Day window.** A day runs from `earlyWindowMinutes` before the shift start (240 by default) to the same point the next day. Night shifts that end after midnight therefore belong to the day they started.
- **Double taps.** Punches within 120 seconds of the previous one are ignored for calculation (they stay stored).
- **Unknown directions.** When a punch has no in/out (some devices, or `directionFromDevice` off), directions alternate in, out, in, out.
- **Worked time.** The sum of in-to-out intervals. If the paid break was not taken, the shortfall is deducted only when the person worked at least a half day plus the break.
- **Late and early leaving.** Counted only beyond the shift's grace minutes. Half-day leave excuses the half it covers.
- **Status.** Full day or half day by worked minutes; missing punch when an in has no out (or the reverse); absent with no punches on a working day; leave, half-day leave, holiday and weekly off from Phase 2 data; not employed before joining or after exit.
- **In progress.** Today's day stays "in progress" until the shift end plus 6 hours (or local midnight without a shift), so nobody shows as missing a punch-out while still at work.
- **Overtime.** On working days, worked minus (shift length minus break), counted only from the shift's minimum. On days off, all worked time. When the policy needs approval, overtime is only claimed; the approved figure is stored separately.
- **Time zones.** Days are worked out in the employee's own time zone (location, then legal entity, then workspace), with correct DST handling.

### Punching
- **Web punch** with the browser's location. Location is checked against the location's geofence (set in Phase 1). The accuracy circle gets the benefit of the doubt, and a fix worse than 1 km counts as "unknown", not "outside".
- **Geofence modes** per policy: off, warn (punch kept and flagged "outside area") or enforce (punch refused, and the refusal is written to the audit trail).
- **QR kiosks.** A kiosk is a screen at the entrance, opened with a link that carries a secret token in the URL fragment. It shows a QR code that changes every 30 seconds. Staff scan it with their phone while signed in to CREW, so the punch is theirs; the kiosk itself is never signed in. Codes are HMAC-signed with a key derived from the server secret, only the current and previous 30-second windows are accepted, and each code records at most one punch per person.
- **Mobile.** The API accepts `source: mobile` with a client event id so an offline phone can sync later without duplicates. The mobile app itself is a later phase.

### Corrections, overtime and approvals
- Employees ask to add missing punches for a past day inside the policy's correction window (30 days by default). Future days, locked days and a second pending request for the same day are refused.
- Overtime claims go to approval when the policy requires it.
- Both use the Phase 2 approvals engine: manager first, falling back to HR admin. HR and attendance admins can raise corrections for others.
- Approving leave, or cancelling approved leave, recalculates the affected days.

### Shifts, rosters and swaps
- Shift templates: start and end (crossing midnight allowed), break, grace, half and full day thresholds, overtime switch and minimum, colour.
- Each new workspace gets a General shift (09:00 to 18:00, 60 minute break) and a default policy that uses it.
- Rosters cover up to 63 days for a department or location. Drafts can be edited freely and do not apply until published; publishing notifies everyone on it.
- Which shift applies on a day: published roster, then a manual assignment, then the policy's default shift on working days.
- Shift swaps between two colleagues on the same date: the colleague accepts, then the manager approves. The swap is refused at approval time if either person's shift changed in the meantime.

### Payroll locks
- HR locks a period (whole workspace or one legal entity) once payroll has used it. Locked days are never recalculated.
- Corrections for locked days are refused. A device punch that arrives late for a locked day is stored with `arrived_after_lock` set and does not change the day.
- Unlocking needs a reason, which is audited.

### Biometric devices (ZKTeco and eSSL push)
- Devices are registered by serial number. Real devices use the vendors' published HTTP push protocol (often called ADMS or iclock): the device calls CREW at `/iclock/cdata` and sends attendance logs by itself. CREW never connects into the customer's network.
- A device is identified by its serial number, which is unique among live devices. An optional allow-list of IP addresses or CIDR ranges can be set, and the screen recommends it.
- Device users are enrolment numbers. HR maps each number to an employee, either for one device or for every device. Punches from numbers not yet mapped are kept and count as soon as they are mapped, for the last 62 days.
- Status is derived from the last contact: waiting, online, delayed, offline, error. HR admins are notified when a device goes offline.
- Every contact is written to an ingest log with record counts, duplicates and rejections.
- A **simulated device** sends test punches through the same ingest pipeline from the device screen (normal day, late with missing punch-out, repeated punches, unknown person). It refuses real pushes and is labelled as simulated everywhere.
- Fingerprints and faces stay on the device. CREW stores only the punch event and which verification method was used.

### Web Portal screens
- **Attendance:** today's card with punch in or out, the month with each day's status and minutes, a correction dialog, an overtime claim dialog and the list of corrections.
- **Day detail:** the raw punches with source and geofence result, and the engine's explanation.
- **Team attendance:** a scoped daily view for managers and HR, with who is on site now.
- **Punch with QR:** the page a phone opens after scanning a kiosk.
- **Shifts:** my schedule, swap requests, and rosters with a grid editor.
- **Attendance settings:** shifts, punching policy and location overrides, payroll locks, QR kiosks (the link is shown once), and recalculation of a date range.
- **Attendance devices:** list with live status, registration, and a detail page with setup values, enrolment numbers and mapping, the ingest log, and the simulator for simulated devices.
- **Kiosk screen** at `/kiosk`, outside the signed-in app.

## Demo data
The demo workspace now also has:
- A Night shift (22:00 to 06:00) next to the General shift, and a Pune Plant policy override.
- About five weeks of punches for three Pune staff, including a late arrival pattern and one forgotten punch-out to try a correction on.
- A simulated device, "Pune gate", with two enrolment numbers mapped and one left unmapped so the mapping flow can be tried.

All of it is labelled as demo data. Attendance days are not seeded; the API calculates them from the seeded punches, as it does for real data.

## Tests

| Suite | Count | Covers |
|---|---|---|
| Contracts unit tests | 46 | Earlier tests plus 20 golden tests for the attendance engine (windows, night shifts, grace, half days, breaks, overtime, leave, holidays, DST, geofence maths) |
| API integration tests | 110 | Earlier tests plus 19 attendance tests |
| Attendance browser test (`e2e/attendance-flow.cjs`) | 1 flow | Operator punches in inside the geofence, asks for a correction on the day with a missing punch-out; supervisor approves from the inbox; the day is recalculated; HR opens every settings screen, registers a simulated device, maps an enrolment number and sends test punches; HR creates a kiosk and the kiosk screen shows a rotating code without signing in; a wrong kiosk link is refused |
| Web Portal, Core HR and console browser tests | 3 flows | As before, still passing |

The attendance integration tests cover:
- Web punching, duplicates by client event id, and geofence warn and enforce (with the audited refusal).
- Raw punches cannot be edited or deleted, even directly in the database.
- The engine on real stored data, including leave and holidays.
- Team scope: a supervisor sees their reports and themselves, not other departments.
- Corrections end to end, with the originals left unchanged; duplicate punches in one request refused; pending, future and locked days refused.
- Overtime claims, which cannot exceed the recorded overtime, and approved overtime on the day.
- Approved leave turning an absence into leave.
- Period locks, including late device punches flagged and not applied.
- Rosters: draft, publish, that drafts do not apply, and that managers can only schedule their own team.
- Shift swaps: accept, approve, and refusal when a plan changed.
- Devices: handshake, ATTLOG parsing and dedupe, mapping that applies earlier punches, the IP allow-list, the simulator, and unknown serial numbers refused.
- QR kiosk: the code shown to the kiosk token, one punch per code, forged and revoked codes refused.
- Workspace isolation for every Phase 3 table.

CI now also runs the attendance browser flow.

### Defects found and fixed during this phase
- The Web Portal's security headers set `Permissions-Policy: geolocation=()`, which silently stopped browsers from sharing location, so every web punch would have been recorded without a location. It is now `geolocation=(self)`. The browser test found this.
- Just after midnight, a punch looked for earlier punches in the new calendar day instead of the work day still running, so a punch-out at 00:03 was recorded as a punch-in. Punching and the Today card now use the work day whose window contains the current time. CI found this when it ran after midnight India time.
- A correction could list the same punch twice, adding two identical punches on approval. The request is now refused.
- The audit entry for a punch refused by the geofence was rolled back together with the refusal. It is now written separately.
- A circular module import made the API fail to start once attendance depended on leave. Fixed by moving the shared employee scope.

## Security verification
- Every new table has forced Row-Level Security and composite workspace foreign keys, checked by the isolation test.
- Raw punches and the device ingest log are insert-only for the API login. Periods cannot be deleted, only unlocked with a reason.
- Every new route declares its permission and plan feature; the OpenAPI spec now has 196 operations.
- Devices push without a user login, as the vendor protocol requires. They are accepted only for a registered, non-archived serial number, optionally only from allowed addresses, and records are size-limited (2 MB per request). A request from an unknown serial is refused and nothing is stored.
- Kiosk tokens are stored only as a SHA-256 hash and shown once. The token travels in the URL fragment, so it is not written to server logs; the kiosk screen posts it to the Web Portal, which forwards it to the API in a header.
- QR codes are short-lived, signed, and bound to the kiosk; scanning needs a signed-in employee.
- No biometric templates are received or stored.
- Out-of-scope employees and days return 404.

## Known limits
- **Device adapter is Preview.** The ZKTeco and eSSL push adapter follows the vendors' published push protocol and is tested with recorded message formats and the simulator, but it has not yet been validated against physical devices and firmware versions. The screens say so. Validate with one device before a rollout.
- **No commands are sent to devices.** CREW does not yet push users, clear logs or sync time on devices. Enrolment stays on the device.
- **Pull-only devices are not supported yet.** A local sync agent for devices that cannot push (the planned Go agent) is deferred.
- **No partitioning yet.** `attendance_events` is a single table with indexes. Monthly partitioning is designed for but deferred until volumes need it.
- **Swaps are same-date only.** Swapping shifts across different dates is not built.
- **No consent records or jurisdiction switches** for location and biometric data yet. Workspaces should run their own notice and consent process until this lands.
- **Mobile app** is a later phase; the API side for mobile punches is ready.

## Next: Phase 4 (Recruitment)
- Requisitions and approvals.
- Candidate records and pipeline (ATS).
- Interviews and scorecards.
- Career pages.
