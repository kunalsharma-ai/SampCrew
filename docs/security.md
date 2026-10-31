# CREW Security and Privacy Design

This document describes the controls implemented so far and the plan for the rest. It does not claim any certification; SOC 2 / ISO 27001 readiness and regulatory validation (GDPR, UK GDPR, DPDP Act, CCPA/CPRA) require independent assessment, scheduled for Phase 10.

## Implemented in Phase 1

| Area | Control | Where |
|---|---|---|
| Tenant isolation | PostgreSQL Row-Level Security with `FORCE ROW LEVEL SECURITY` on every tenant table; the API's login role (`crew_api`) has no privileges and must `SET LOCAL ROLE crew_app` (RLS enforced) or `crew_platform` (auth bootstrap and console only) inside each transaction, so a forgotten wrapper fails closed | `packages/db/migrations/0001_foundation.sql`, `apps/api/src/platform/database` |
| Cross-tenant references | Composite foreign keys `(tenant_id, id)` make it impossible to point a record at another tenant's row | migration |
| Column-level protection | The tenant role cannot select `password_hash` or `mfa_secret_enc` | migration grants |
| Authentication | argon2id (OWASP parameters), 12+ character passwords with complexity, lockout after 5 failures for 15 minutes, constant-time behaviour for unknown accounts | `platform/auth` |
| MFA | TOTP (RFC 6238); secrets encrypted with AES-256-GCM; tenants can require MFA for everyone; sensitive permissions (roles, billing, payroll, integrations, AI configuration) require an MFA session | `platform/auth`, `permissions.ts` |
| Sessions | 15-minute JWT access tokens bound to a server-side session (checked every request, so revocation is immediate); 30-day refresh tokens stored as SHA-256 hashes, rotated on every use, with reuse detection that revokes the whole session family | `auth.service.ts` |
| Authorisation | RBAC roles with ABAC scopes (own / team / department / entity / tenant), assignment constraints, MFA conditions; list queries filter in SQL; out-of-scope records return 404 so existence does not leak; owner role cannot be granted by non-owners; last owner cannot be removed | `platform/authz` |
| Audit | Append-only (trigger + no UPDATE/DELETE grant) and SHA-256 hash-chained per tenant; written in the same transaction as the change; secrets redacted; verification endpoint detects tampering | migration, `platform/audit` |
| Platform staff | Separate table, signing key, sessions and login; MFA mandatory; no tenant data access without a customer-approved, time-boxed support grant, which is audited in the customer's own trail | `modules/platform-admin` |
| API hygiene | Input validation on every route (zod), uniform error envelope without stack traces, request ids, helmet security headers, CORS allow-list, rate limiting per client address (stricter on auth routes; the Web Portal forwards the visitor's address taken from the right-most `X-Forwarded-For` entry, so the proxy in front of it must set that header), Idempotency-Key support | `platform/http` |
| Attendance | Raw punches append-only (trigger + insert-only grant) and deduplicated; derived days rebuilt, never hand-edited; corrections add punches through approval; payroll locks freeze days. Devices accepted only by registered serial and optional IP allow-list, with request size limits; kiosk tokens stored hashed and kept in the URL fragment; QR codes HMAC-signed, 30-second windows, one punch per person per code; no biometric templates stored | `modules/attendance`, `0003_attendance.sql` |
| Recruitment | Public career site resolves the workspace from its address and then runs inside that workspace's RLS context, returning public posting fields only; applications need consent to a versioned privacy notice, are rate limited per visitor, size limited, CV content-checked (PDF, .docx), and get the same response whether or not the person already applied; manual candidates need a recorded lawful basis; application history append-only with no free text; scorecards hidden from other interviewers until they submit; offer approval needs an MFA session; CV links HMAC-signed per file kind, 5 minutes, audited; erasure on request and automatic retention | `modules/recruitment`, `0004_recruitment.sql` |
| Secrets | No secrets in code; configuration validated at start-up and the process refuses weak or missing keys | `platform/config` |

## Planned

- Phase 2: field-level envelope encryption (per-tenant data keys via KMS) for bank, tax and national ID fields; signed URLs for documents; malware scanning of uploads.
- Consent records and jurisdiction switches for location and biometric data (Phase 3 stores punch events only, never biometric templates).
- Redis-backed distributed rate limits and session cache before multi-replica deployment.
- Phase 10: SSO (SAML/OIDC), SCIM, data residency cells, DR drills, external penetration test, privacy request tooling (access, erasure, portability) and retention schedules.
