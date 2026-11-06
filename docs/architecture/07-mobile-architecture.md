# 7. Android and iOS Architecture

> **As built in Phase 7:** the first version of the app follows this design with some differences (JSON outbox instead of SQLite, no device-key signing, no certificate pinning or root detection, `crew://` scheme instead of universal links). See [the Phase 7 report](../phases/phase-7.md#differences-from-the-phase-0-mobile-design).

## 7.1 Framework decision: React Native (Expo) over Flutter

| Criterion | React Native + Expo | Flutter |
|---|---|---|
| Share code with web/API | Shares TypeScript contracts, zod validation, API client, permission catalogue, i18n strings | Needs a Dart re-implementation of every schema, or code generation from OpenAPI |
| Native capabilities needed | Biometrics (`expo-local-authentication`), secure storage (`expo-secure-store` → Keychain/Keystore), location + background geofencing (`expo-location`, `expo-task-manager`), camera + QR (`expo-camera`), push (`expo-notifications` → APNs/FCM), offline DB (`expo-sqlite`/WatermelonDB) | Equivalent plugins available |
| Performance | New Architecture (Fabric, TurboModules, Hermes) is sufficient for list-heavy business apps | Slightly smoother custom animation |
| Team and hiring | Same TypeScript developers as web | Separate Dart skill set |
| Over-the-air fixes | EAS Update for JS-only fixes (within store rules) | Not built in |

Decision: **React Native with Expo (development builds, bare workflow if a vendor SDK requires it)**. The deciding factor is a single source of truth for API contracts and validation across web, API and mobile, which the brief explicitly requires ("keep web and mobile experiences consistent").

## 7.2 One app, four experiences

A single store app, `SampCrew`, whose navigation is assembled from the signed-in user's permissions:

| Experience | Shown when user has | Key tabs |
|---|---|---|
| Employee | any active membership | Home, Attendance, Leave, Pay, Me |
| Manager | `team`-scoped approve permissions | Team, Approvals |
| Recruiter | `candidates:read` | Candidates, Pipeline, Interviews |
| HR | `employees:read` at `tenant`/`entity` scope | People, Onboarding, Approvals, Copilot |

## 7.3 Structure

```
apps/mobile/
├── app/                       expo-router file-based routes
│   ├── (auth)/                login, MFA, biometric unlock
│   ├── (employee)/            attendance, leave, payslips, documents, helpdesk
│   ├── (manager)/             approvals, team dashboard, shifts
│   ├── (recruiter)/           candidates, pipeline, interview feedback
│   └── (hr)/                  people, onboarding, copilot
├── src/
│   ├── api/                   generated client from OpenAPI + @crew/contracts types
│   ├── offline/               SQLite store, outbox queue, sync engine
│   ├── security/              secure storage, biometric gate, jailbreak/root signals
│   ├── attendance/            GPS, geofence, QR scan, selfie verification (where lawful)
│   └── ui/                    React Native implementation of @crew/ui tokens
└── app.config.ts              per-environment config, no secrets
```

## 7.4 Security

- Tokens in Keychain (iOS) / Keystore-backed EncryptedSharedPreferences (Android) via `expo-secure-store`; never in AsyncStorage.
- Optional biometric unlock gates the refresh token; the device never sends biometric data to SampCrew.
- Certificate pinning for the API host (with a pinned backup key) in production builds.
- Root/jailbreak and mock-location detection signals attached to attendance punches as risk flags (not hard blocks, to avoid false positives locking employees out).
- Screens showing payslips and bank details set `FLAG_SECURE` on Android and blur on app switch on iOS.
- Remote session revocation: refresh fails, local data is wiped.

## 7.5 Offline attendance and sync

1. Punch is captured with device monotonic time, wall-clock time, GPS fix + accuracy, geofence result, network state and a per-device sequence number.
2. Stored in the local SQLite outbox, signed with a device key registered at login.
3. Sync engine uploads batches with `Idempotency-Key = deviceId:sequence`; the server dedupes and stores raw events immutably.
4. Server responds with the authoritative computed day; conflicts are never resolved silently on device.
5. Clock tampering is detected by comparing monotonic deltas to server time at next sync and flagged for review.

## 7.6 Push and deep links

- Push via APNs/FCM through Expo Push or direct; payloads carry IDs only, never personal data.
- Universal links / App Links: `https://app.crew.sampledge.com/approvals/{id}` opens the app if installed, otherwise the web portal, with identical routes on both.

## 7.7 API design implications (applied from Phase 1)

- All endpoints are bearer-token friendly; no cookie-only flows.
- Cursor pagination for list endpoints (stable under inserts, good for infinite scroll).
- `ETag`/`If-None-Match` on reference data so mobile can cache.
- Idempotency keys on every create that the mobile app may retry.
- `/api/v1/me` returns permissions, entitlements and feature flags so the app can build navigation without extra calls.
