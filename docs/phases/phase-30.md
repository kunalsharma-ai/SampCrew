# Phase 30 report: data import, field management and master data

Phase 30 brings records into SampCrew from spreadsheets and keeps the choices behind dropdowns in one place:

- **Data import** (`/imports`): Upload > Match columns > Check and preview > Import > Report, for employees, candidates, clients, client contacts, departments, job titles and the other master data lists. Nothing is saved to records until the person presses Import.
- **New columns become fields**: a column SampCrew does not know is shown as "New field detected". The person creates a custom field for it (the type and choices are suggested from the values) or ignores the column.
- **Records you already have**: rows that match an existing record are skipped, updated, added anyway, or decided one by one ("Let me decide for each one").
- **Master data** (`/settings/master-data`): industries, departments, job titles, job roles, skills, education, candidate sources, seniority levels, locations and the built-in employment lists. Each list has a ready-made library, its own values, categories, codes, and values that are disabled (never deleted) while in use.
- **Custom field flags**: required, searchable, visible per level (Super and HR Workspace always, the Employee Workspace when ticked), available during import, options from a master data list, decimal places.
- **Employee data permissions per HR Workspace**: the Super Workspace switches view, edit, create, import, export and manage fields off for one HR Workspace.
- **Bulk changes** on the Employees list: pick people and change their department, job title, location, manager (dated job changes) or one custom field together.

Plan feature: `data_import` (all plans, administrators only). Permissions: `imports:run`, `imports:read`, `masterdata:manage`, `employees:export` (new), plus the record's own permission (for example `employees:create` for employees). Migration: `0060_data_import` (range 0060-0069).

## Working end to end, and not yet

### Working end to end
Each item runs against the real API and MongoDB. API tests: `apps/api/test/data-import.spec.ts` (18 tests across the Super Workspace, the HR Workspace and the Employee Workspace). Browser flows: `e2e/data-import-flow.cjs` (`pnpm e2e:data-import`) and the import step of `e2e/hr-workspace-flow.cjs`.

- **Upload**: .xlsx and CSV (comma or semicolon), up to 20 MB and 20,000 rows. An old .xls file is refused with how to save it as .xlsx. Each kind of record has an Excel template with an Instructions sheet.
- **Matching columns**: exact names and known synonyms ("Emp ID", "DOJ", "Reports to") are matched. A close spelling ("Mobil Number") is only *likely* and waits for Confirm. Nothing uncertain is matched silently, and the check cannot start until every likely match is confirmed and every new column is created or ignored. One field cannot take two columns.
- **New fields from the import**: created as real custom fields in the section "Imported", recorded in the audit trail with `via: import`. In the browser flow, "Canteen Plan" became a Dropdown with Jain, Non-veg and Veg.
- **The check**: every row is checked against SampCrew as it is now. Problems come with the column, the message and a suggested correction ("Did you mean ...", date formats). Duplicates inside the file are flagged on both rows. A manager can be in SampCrew or in the same file. Missing departments, skills, qualifications, industries and sources are added when the option is ticked (each shown as a warning first). Work locations are never added this way.
- **Import**: runs in the background, row by row, each row in its own transaction (the record, its profile, custom fields, leave balances and assets together, or nothing). Every row is checked again just before it is written, and the import stops if the feature, the permission or the person's access changes while it runs. A stopped import can carry on. A notification says when it finishes.
- **Report**: Excel with Summary, Problems (row, column, problem, suggested correction), Rows to fix (ready to correct and upload again) and All rows. Import history lists every import with who ran it, when and what happened.
- **Imported employees are ordinary records**: in the browser flow four people were added (one manager from the same file, a new department and two new job titles created on the way), the existing employee was updated with the new field, and the error row was left out. "See the records" opens `/employees?importId=...` with exactly those people.
- **Bulk changes**: two imported people moved to Finance together, each as a dated job change in their history. Someone outside the caller's reach is refused alone, without their name.
- **Master data**: an industry was added, disabled (it leaves every dropdown, records keep it), and the library of job roles opened. The client form's Industry uses the list with "Other / add new"; a typed value joins the list when the person may change it.
- **Levels**:
  - Super Workspace: imports for the whole company, into any HR Workspace or the central group.
  - HR Workspace: imports only for its own HR Workspace (another HR Workspace is refused and audited). The browser flow switched "Import employee data" off for an HR Workspace and its admin lost Data import at once; the API refuses too.
  - Employee Workspace: never imports. `data_import` cannot be switched on for that level by any screen, and the permissions are not in its roles. Fields created without "Employees see it" stay hidden from employees.
- **ID manipulation**: an import outside your reach reads as "not found"; only the person who started an import can change or run it; matching only sees records the importer may see.
- **Audit trail**: `import.uploaded`, `import.mapped`, `import.validated`, `import.decided`, `import.completed` or `import.failed`, `import.cancelled`, `import.report_downloaded`, `custom_field.created` (via import), changes to master data values (with `via`), `employee.bulk_changed`, `hr_workspace.permissions_changed`, and `authz.denied` for a refused HR Workspace.

### Not yet working, or not yet verified
- **Candidates, clients, contacts, departments, job titles and other lists are covered by API tests only.** The browser flow imports employees; the same screens serve the other kinds, but they have not been clicked through in a browser.
- **No undo of a whole import.** Rows already imported stay (each complete). People added by mistake are exited or archived one by one.
- **Bulk changes do not archive, delete or change status** (exits keep their own reasons and dates). Bulk changes cover department, job title, location, manager and one custom field.
- **"Other / add new" is on the client Industry field.** The hire form already takes typed job titles and the other dropdowns still pick from the list only.
- **No scheduled or repeating imports**, no import from Google Sheets or another HR system's API, and no import of attendance, payroll or documents.
- **Very large files**: tested up to the row limit in API tests with small rows; a full 20,000-row employee file has not been timed on production hardware.
- **Mobile app**: no import or master data screens (they are administrator settings on the web).

## What was delivered

### API (`apps/api/src/modules/data-import`, `master-data`)
- `DataImportService`: upload, mapping (with new fields), check, decisions, background run, cancel, carry on, history, report, templates. Rows live in `import_job_rows`; jobs in `import_jobs`. A job with no heartbeat for 3 minutes is marked "Stopped, can carry on".
- Adapters, one per kind of record, write through the record's own service (`EmployeesService.create`, `changeJobIn`, `ProfileService.importSections`, `CandidatesService`, `BidsService.createContactIn`, `MasterDataService.createIn`), so an imported record passes the same rules as one made on its form.
- `EmployeeBulkService` (`POST /employees/bulk`).
- `MasterDataService`: lists, values, options for dropdowns, library, add, rename, disable. Departments, job titles, skills and locations are the existing records, not copies.
- HR Workspace employee data permissions (`PUT /hr-workspaces/:id/permissions`), enforced when the person's access is loaded.
- Client contacts (`/staffing/clients/:id/contacts`), multi-sheet Excel export, `employees:export` on the export routes.

### Web
- `/imports` (hub and history), `/imports/new` (upload), `/imports/[id]` (match columns, check and preview with filters and decisions, progress, report), `/import-report/[id]`, `/import-template/[type]`.
- `/settings/master-data`, the master data dropdown with "Other / add new", Custom fields flags, the HR Workspace "Employee data permissions" card, row selection on the shared list table and the bulk change dialog.
- The old `/employees/import` page now opens Data import. Navigation: "Data import" under Employee management, "Master data" under Administration. Help for every new page and section.

### Screenshots
`crew-preview/data-import/` in the project Library: hub, upload, suggested matches, new field, check with problems, decisions, finished import, bulk change, master data, library, HR Workspace with import on and off, and the Employee Workspace without it.
