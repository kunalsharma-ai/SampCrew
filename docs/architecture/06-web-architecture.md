# 6. Web Application Architecture

SampCrew ships two web applications that share the design system and contracts but have separate deployments, domains and authentication realms:

| App | Path | Domain (prod) | Users |
|---|---|---|---|
| Web Portal | `apps/web` | `app.crew.sampledge.com`, `{tenant}.crew.sampledge.com`, custom career domains | Tenant users of every role, public career pages |
| Super Admin Console | `apps/console` | `console.crew.sampledge.com` (IP allow-listed, MFA mandatory) | SAMPLEDGE staff only |

Keeping the console separate means a vulnerability in the tenant portal cannot be used to reach platform administration, and the console can sit behind a VPN or zero-trust proxy.

## 6.1 Rendering and data flow

- **Next.js App Router.** Server Components fetch from the API on the server using the user's session cookie, so dashboards render with data on first paint. Client Components handle interactivity (forms, drag-and-drop pipelines, charts).
- **Backend-for-frontend boundary.** The API is a pure bearer-token API (the same one mobile and integrators use). The Next.js server acts as the BFF: on login it receives the access and refresh tokens and stores them in `httpOnly`, `Secure`, `SameSite=Lax` cookies on the web domain. The browser never sees a token in JavaScript. Server Components and Server Actions read the cookie and call the API with `Authorization: Bearer`, refreshing transparently. Server Actions get Next.js's built-in Origin check, which together with `SameSite=Lax` covers CSRF.
- **API client.** A typed server-only client in `apps/web/lib/api.ts` built on `fetch`, using types from `@crew/contracts`. Forms validate with the same zod schema the API uses, and the API validates again.
- **Caching.** Server fetches are `no-store` for tenant data (correctness and isolation first). Static marketing and career pages use ISR.

## 6.2 Route structure (web portal)

```
app/
├── (auth)/login, mfa, forgot-password, accept-invite
├── (app)/                          authenticated shell: sidebar, top bar, command palette
│   ├── page.tsx                    role-aware home dashboard
│   ├── organization/               legal entities, locations, departments, business units
│   ├── people/                     Phase 2
│   ├── time/                       Phase 3 attendance, devices, shifts
│   ├── recruiting/                 Phase 4
│   ├── payroll/                    Phase 5
│   ├── talent/                     Phase 6
│   ├── automation/                 Phase 8
│   ├── settings/                   users, roles, audit log, billing, integrations
│   └── me/                         employee self-service
└── careers/[tenantSlug]/           public career site (Phase 4)
```

Navigation entries are filtered by two things the API returns at login: the user's effective permissions and the tenant's entitlements. A module a tenant has not bought shows as a discoverable upgrade card for owners/admins and is hidden for everyone else. The server always enforces the same checks, so hiding is a UX nicety, not a security control.

## 6.3 Role-based dashboards

The home route chooses a dashboard layout from the user's highest-level role (executive, HR leader, HR admin, recruiter, hiring manager, payroll admin, department manager, employee). Each layout is a list of widgets; users can rearrange, pin and save filters (stored per membership as JSON, validated against the widget catalogue).

## 6.4 Cross-cutting UI features

- **Command palette** (Ctrl/Cmd+K): navigation, record search, quick actions, "Ask SampCrew" AI prompt.
- **Global search** across people, candidates, requisitions, documents (permission-filtered by the API).
- **Notifications** drawer with realtime updates over WebSocket.
- **Contextual AI** side panel per page (Phase 8).
- **i18n**: `next-intl`, locale per user, right-to-left support, dates and currency via `Intl`.
- **Accessibility**: WCAG 2.2 AA target, keyboard-first, native `<dialog>` and form controls (Radix primitives where native HTML falls short), axe checks in Playwright.

## 6.5 Security headers

Strict CSP with nonces, `frame-ancestors 'none'` (except embeddable career widgets), HSTS, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` limiting camera/geolocation to the attendance pages that need them.
