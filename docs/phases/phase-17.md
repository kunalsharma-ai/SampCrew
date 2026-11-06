# Phase 17 report: SAMPLEDGE feedback on setup, hiring and logins

This phase answers the feedback from SAMPLEDGE (6 November 2026):

1. Employees had no photo.
2. Hiring did not register people for attendance or give them working sign-in details.
3. A new company had to add employees before it had described itself.
4. Designations and departments were empty in the hire form, and there was no way to add one without leaving it.
5. Admins and the SAMPLEDGE Super Admin could not see or control an employee's login.

Outlook signature sync (feedback item 4 of the original list) is **not** in this phase. It waits on a decision about how it should work. See "Not yet working".

## Working end to end

Each item below runs against the real API and PostgreSQL. API tests are in `apps/api/test/feedback.spec.ts` (23 tests). The browser flow is `e2e/setup-flow.cjs` (`pnpm e2e:setup`, in CI). The HR, directory and Super Admin flows were updated and pass.

### First-login company setup (`/setup`)
- A new workspace's administrator (`org:manage`) lands on `/setup` from the home page until setup is finished. "Finish later" sets a cookie, and the home page shows a "Finish the company setup" item.
- The wizard has five steps:
  1. **Company**: name, legal name, industry, size, website, HR contact, phone, country, currency, time zone, financial year, registration number, tax ID and address. These are saved on the workspace and its main legal entity.
  2. **Locations**: add or skip.
  3. **Departments**: ready-made list for the chosen industry, all ticked by default. You can add your own, and rename or remove what was added.
  4. **Designations**: the same, with levels.
  5. **Finish**: opens the guided hire.
- The ready-made lists are in `packages/contracts/src/setup.ts`. They cover 10 industries plus a general list for "Other". Names that already exist are skipped (case-insensitive), and a department code that is already taken is dropped.
- Existing workspaces that already have employees are marked as set up by migration 0024, so nobody is sent back.
- Renaming the workspace after setup needs `tenant:manage` (owner, with two-step verification).
- **Bug found and fixed by the browser flow:** the wizard was remounted after each save, which wiped whatever the admin had just started typing on the next step.

### Add new from the hire form
- The guided hire has "New designation", "New department" and "New location" for people with `org:manage`. It also has "New shift" (name, start and end) for people with `attendance:configure`.
- The new entry is saved to the database, added to the list and chosen. A name that is already on the list is simply chosen and is not added twice.
- Organization structure has a new **Designations** tab with add, rename and remove.

### Employee photos
- PNG, JPEG or WebP up to 5 MB. The file contents are checked against the declared type.
- A photo can be added on the first step of the hire, or from the profile. HR can change anyone's photo; employees can change their own.
- Photos are served through `/employee-photos/:id` behind the session. They show in the employee list, on the profile and in the top bar for the signed-in person (`/me` now includes `employee: { id, photoUpdatedAt }`).
- On the profile, HR has **Change** and **Remove** under the photo as well as the camera button.
- Employees manage their own photo:
  - **Web**: a "Your photo" card at the top of Settings, Appearance, opened from their avatar, to upload, change or remove it.
  - **Mobile**: a "Your photo" card on the Me tab to choose from the phone's photos, take one with the camera (not in the browser build), change or remove it. It uses `expo-image-picker` 57.0.20 with photo and camera permission texts. The photo is downloaded with the session and shown from memory.
- Only the browser build of the mobile app was tested. The camera and native photo picker on real phones still need a check on a device.

### Attendance registration
- At hire (step "Attendance & access") and later from the profile, HR sets two things:
  - The **usual shift**. The employee's own shift is used before the location default; rosters still win.
  - **Attendance machine enrolment numbers**, per machine or for any machine.
- An enrolment number that someone else already uses is refused, and the hire is rolled back.
- Changing enrolments needs `devices:manage`. Attendance days are recalculated after a change.

### Logins created by HR
- At hire, HR chooses one of three options:
  - **No login for now**.
  - **Create the login now**: a 16-character temporary password is generated, or HR types one.
  - **Email an invitation**.
- A generated temporary password is shown once, with a copy button. It is never emailed and never saved in a hire draft.
- At the first sign-in on the web or the mobile app, the employee must choose their own password before going on (`POST /auth/initial-password`, single-use token). The temporary password cannot be reused.
- An email that already has a CREW account is refused (409 `account_exists`), and the hire is rolled back.
- An existing employee without a login gets a "Create login" card on their profile.

### Login control (workspace admin)
- Admins with `users:manage` see a **CREW login** card on the employee profile showing:
  - login ID
  - status
  - whether a password is set
  - two-step verification
  - last sign-in
  - devices signed in
  - lock time
- **The password itself is never shown.** It is stored only as a one-way hash, so nobody can read it.
- Actions on the card:
  - **Reset password**: a new temporary password is shown once, old sessions end, and the person must choose a new password at the next sign-in.
  - **Force password change**.
  - **Lock** and **Unlock**. Unlock also clears a lock caused by too many wrong passwords.
  - **Sign out everywhere**.
- Every action is audited as `employee.login_*`.
- Refused cases:
  - An admin's own login: use Settings, Security instead.
  - Another owner's login, unless the admin is an owner.
  - Password changes for an account that is also active in another company's workspace (409 `shared_account`). Those go to the person or to SAMPLEDGE.

### Login control (SAMPLEDGE Super Admin Console)
- Workspace, Users gains these actions, each with a reason and audited:
  - **Reset password**: shown once in the Console, and applies to every workspace the account is in.
  - **Force password change**.
  - **Lock account**: blocks sign-in to every workspace.
  - **Unlock account**.
- The Users list shows "must change password" and "locked until".

## Not yet working, or not yet verified
- **Outlook signature sync is not built.** It needs a choice between two approaches:
  - CREW holds the signature templates, and a small Windows agent installs them into Outlook 2013 on a schedule or on "Sync now".
  - Connect to SAMPLEDGE's existing LightSail signature system.
- **Plaintext passwords are never stored or shown**, by design. Admins reset them instead.
- The mobile app has the "choose your password" step but no photo upload, login control or setup screens.
- Inline "add new" is in the hire form only. The profile's job-change and transfer dialogs still need Organization structure for a new designation, department or location. Onboarding checklists still need Settings, Onboarding.
- Ready-made lists are generic per industry and in English only.

## Database
- Migration `0024_setup_photos_logins.sql`:
  - `employees`: photo columns and `default_shift_id`.
  - `users.must_change_password`.
  - `tenants`: company profile and setup progress columns. `crew_app` gets column grants on the new tenant columns.

## Tests
- API: `apps/api/test/feedback.spec.ts`. `production.spec.ts` lists `POST /auth/initial-password` as a reviewed public route; it needs a signed, single-use, short-lived token and is rate limited.
- Browser:
  - `pnpm e2e:setup`: sign up, setup, first hire with a photo, inline designation and shift, temporary password, first sign-in, then reset, lock and unlock from the profile.
  - `e2e:superadmin` now also resets a password, locks and unlocks from the Console.
  - `e2e:hr` and `e2e:directory` follow the renamed "Attendance & access" step.
