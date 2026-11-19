# Phase 27 report: HR Workspace Admin, background verification and assets

Kunal asked (19 November 2026) for background verification, asset management, a central HR Workspace Admin with a
role and permission matrix, custom fields, and bulk import of existing employees (with leave balances and assets).
Everything below stores its data in MongoDB, is checked by the API (not only the screens) and is in the audit trail.

## Working end to end

- **Background verification** (`apps/api/src/modules/bgv`, web `/verification`). A case per employee with any of six
  checks: identity, address, education, employment, reference and document. Each check moves through Pending, In
  progress, Verified, Failed and On hold, with internal remarks, linked employee documents and uploaded files; the case
  keeps a full history. A case is marked Verified only when every check is verified, and the completion date is
  recorded. Sensitive check details (ID numbers and the like) are encrypted at rest.
  - **Agencies** (`/verification/agencies`): their contacts, services and turnaround. Sending a case creates a private
    link (emailed to the agency, 1 to 90 days, can be switched off) to the public page `/verify/<token>`. The agency
    sees only the files HR shared, sends findings per check and uploads its report; nothing else in SampCrew is
    reachable from the link.
  - **Access**: only people with the new `bgv:*` permissions (HR Admin, HR Manager, HR Executive by default) see
    cases; employees never see their own checks. Cases list and download to Excel.
- **Assets** (`apps/api/src/modules/assets`, web `/assets`, `/assets/mine`, `/assets/categories`, `/assets/reports`).
  - 15 default categories (laptop, desktop, monitor, phone, ID card, SIM and more) plus the workspace's own; each asset
    is numbered per category (LAP-0001) and holds the full register: make, model, serial, purchase date, price and
    vendor, warranty, condition, location, description, remarks and documents.
  - Several assets per employee. Assigning asks the employee to acknowledge receipt: on My assets they type their name
    and confirm, and the acceptance is kept with the date, time and IP address. Return records the date and condition
    and where the asset goes next (available, maintenance or damaged).
  - Lifecycle: available, assigned, under maintenance, damaged, lost and retired, with history.
  - Eight reports in Excel and PDF: by employee, by department, available, assigned, returned, damaged or lost,
    purchases and maintenance.
- **HR Workspace Admin** (`/settings/hr-admin`).
  - **Modules**: every module in the plan, switchable off (and back on) for the whole workspace. A module switched off
    is refused by the API with `feature_switched_off` and disappears from the menu. Core modules are always on, and
    the plan (set in the Console) still decides what can be switched on.
  - **Permissions**: every role against every permission, grouped by module and the seven actions View, Create,
    Edit, Delete, Approve, Export and Manage. Built-in roles (including HR Executive and Reporting Manager) can be
    changed and put back to their defaults; Workspace Owner cannot be changed, so a workspace cannot lock itself out.
    Nothing is granted automatically.
  - **Settings**: links to every module's settings page.
- **Custom fields** (`/settings/custom-fields`). Fields on employees, assets, verification cases, candidates and leave
  requests, in 14 types (short and long text, number, date, date and time, dropdown, multi-select, radio, checkbox,
  email, phone, file, currency, URL). Each has required, default, options, help text, a section and an on/off switch,
  and field-level permissions (which roles may see or change it, and whether the employee may change their own).
  Fields are archived rather than deleted when they hold values; every change is in the field change log. The values
  show on the employee profile, the asset page and the verification case.
- **Existing employees** (`/employees/import`). An Excel template with a column per leave type; a check run shows every
  problem on every row (duplicate codes or emails, unknown department, location or legal entity, bad dates or phone
  numbers, unknown or unavailable assets, a manager not found) before anything is created. Import creates managers
  before their reports, sets opening leave balances and hands over the assets listed. The hire form's "Already working
  here" choice also has an asset picker.
- **Employee profile**: new Verification and Assets tabs and the workspace's custom fields.

## Data and upgrades

- New collections (created by the migrator on deploy): `workspace_modules`, `custom_fields`, `custom_field_values`,
  `custom_field_files`, `bgv_agencies`, `bgv_cases`, `bgv_checks`, `bgv_files`, `bgv_events`, `bgv_agency_links`,
  `asset_categories`, `assets`, `asset_assignments`, `asset_events`, `asset_files`. Existing data is not changed.
- New permissions `bgv:*`, `assets:*`, `modules:manage` and `fields:manage`. On deploy, `syncSystemRolesMongo` gives
  each workspace's built-in roles the new grants once, and remembers what it gave (`roles.template_grants`), so a
  grant HR removes is never added back.
- The two new modules are in every plan from Starter up; the Console can take them out of a plan.

## Tests

- `apps/api/test/hr-workspace.spec.ts`: an internal case to a verified result; an agency case through its link
  (only shared files, findings back, link switched off); verification hidden from employees; categories and asset
  numbering; assign, acknowledge and return; every report in both formats; assets handed over on the hire form;
  custom field types, field permissions, archive and log; module switches and the role matrix with reset; the role
  sync for existing workspaces; and the import check and run.
- `apps/api/src/platform/export/tabular.spec.ts`: reading Excel files.
- `apps/api/test/plan-coverage.spec.ts` covers every new route; `apps/web/lib/help-content.spec.ts` covers the
  help for every new page and section.

## Not yet

- Assets cannot be handed over in bulk (one asset at a time, or through the import).
- An agency report is a file; structured scoring per check is not in this phase.
