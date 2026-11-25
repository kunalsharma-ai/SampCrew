# Issue #86: feedback of 25 November 2026

All points of issue #86 and the attached Word file, in one change. Migration `0200_feedback_25_nov`.

| Point | Where |
| --- | --- |
| Customize layout boxes overlap (I1) | `home-dashboard.tsx`: dashed border with padding instead of an outline, `items-start` grid |
| Read notifications leave the bell (I2) | `notification-bell.tsx`: Unread / Action needed only; marking read removes it everywhere (live signal) |
| Legal name (I3) | `employees.middle_name`; profile shows Legal name (first, middle, last) with Preferred name separate |
| "No files" (I4) | BGV case page lists the employee documents linked to its checks; "No files yet" only when there are none |
| Add Employee scrollbars (I5) | `packages/ui` Dialog: only the body scrolls, header and footer fixed |
| "Resource not found" on hire (I6) | HR Workspace admins: access read again after the hire before opening leave balances |
| Chat actions (I7) | edit for 15 minutes (Edited), delete with 30-second undo, emoji reactions, own only (HR may delete) |
| W1-W3 | email password masked and locked; GPS choice and registration IP; only Super Workspace registers companies; registered info locked |
| H1-H20 | shell (no bottom-left user, My Workforce / My Day switch, Settings under My profile, compact view, Favourites without star), Home (card setup page `/settings/home`, compact quick actions, download buttons, setup pop-up, first-login tour, hidden widgets), Team Attendance download and Add employee, GPS and IP per sign-in, WFH remark column, activity log `/activity`, employee Record tab with completion score, page access at registration |

Page access: `PAGE_ACCESS_CHOICES` (contracts `page-access.ts`); unticked pages are kept as withheld FEATURE_PARTS keys in
`member_module_assignments`, next to the modules an HR Workspace withholds. Changeable later on the employee page (Page access card).

The first-login tour stays out of the way under browser automation (`navigator.webdriver`) unless `localStorage['crew-tour'] = 'on'`.

Tests: `apps/api/test/feedback-86.spec.ts`, `packages/contracts/src/feedback-86.spec.ts`.
