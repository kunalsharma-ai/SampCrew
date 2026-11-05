# Phase 9 report: integrations

Phase 9 connects CREW to other systems:

- **Workspace API keys** so another system can read CREW data through the REST API, limited to read-only scopes.
- **Outgoing webhooks**: signed messages to the customer's own endpoints when people join, change job, leave, take leave, raise a case or get paid, with retries and a delivery log.
- **Slack**: post to a channel from Automation Studio workflows, connected with an incoming webhook the customer creates in Slack.
- **An integrations page** that lists what is available now and, separately and clearly marked, what is planned.
- **Two new workflow steps**: "Post to Slack" and "Send to a webhook".

Plan feature: `integrations_advanced` (Business and Enterprise). Permission: `integrations:manage` (workspace owners only, needs two-step verification).

## Working end to end, and not yet

### Working end to end
Each item below runs against the real API and PostgreSQL, is covered by API tests (`apps/api/test/integrations.spec.ts`) and by the browser flow `e2e/integrations-flow.cjs`. Slack in these tests is a **local test stub** that stands in for `hooks.slack.com` (`SLACK_WEBHOOK_BASE_URL`, refused in staging and production). Webhooks go to a local receiver.

- **Integrations page** (Settings, Integrations): webhooks, API keys and Slack are available with counts; Microsoft Teams, Google Calendar and Gmail, Microsoft 365, WhatsApp Business, SMS, accounting and job boards are listed as **planned** with nothing to click.
- **API keys**: create with a name, scopes and expiry (30, 90, 180, 365 days or none); the full key is shown once. In the browser flow the key read `/employees`, was refused `/leave/requests` (not in its scopes) and a write, and stopped working the moment it was revoked. The list shows last use, calls and address.
- **Webhooks**: add an endpoint (secret shown once), choose events, send a test event, pause, switch on, rotate the secret, delete; delivery log with filter; each delivery shows what was sent and every attempt, and can be sent again. In the browser flow the test event and a real `leave.requested` event arrived and their signatures verified. API tests cover retries to the sixth attempt, sending again, switching off after 15 failures in a row (the creator is notified), the new secret after rotation, one delivery per event when the outbox repeats one, and refusing private network addresses.
- **Slack**: connect (CREW posts a confirmation first and saves nothing if Slack refuses), send a test message, see the log of calls, disconnect (the stored URL is wiped). Refused while an active workflow uses it.
- **Workflow steps**: a workflow that posts to Slack and sends to a webhook on "Someone applies for leave" was built in Automation Studio, tested (nothing sent), activated, and ran on the operator's real leave request: Slack got "Arjun Kulkarni applied for 2 days of Casual leave", the receiver got the workflow's message. A Slack URL that Slack reports as removed fails the run and marks the connection as not working (API test).

### Not yet working, or not yet verified
- **Not tested against real Slack.** Only the stub has received messages. The connection uses Slack's documented incoming-webhook format (`POST` JSON `{ "text": ... }`), but before production connect a test channel in a real Slack workspace and send a test message.
- **Slack is one-way and one channel per connection.** No Slack app with OAuth, no slash commands, no interactive approvals, no direct messages.
- **API keys can only read**, and only routes that declare one of the allowed permissions. No write scopes, no per-key rate limit beyond the API's general limits, no IP allow-list.
- **Webhook payloads are thin** (ids and the names of changed fields). Receivers fetch details through the API. There is no "full payload" option, and no event for payslips being published, attendance or recruitment yet.
- **Planned connectors are not built**: Microsoft Teams, Google Calendar and Gmail, Microsoft 365 calendar and mail, WhatsApp Business, SMS, accounting systems and job boards. They need partner accounts and their own security review.
- **No developer portal.** The API reference is the generated `docs/api/openapi.json`; there is no hosted documentation or sandbox workspace.
- **Mobile** has no integrations screens (they are owner settings, on the web only).

## What was delivered

### API keys (`apps/api/src/modules/integrations/api-keys.service.ts`)
- Format `crew_<10-character prefix>_<secret>`. Only a SHA-256 hash of the whole key is stored; the prefix is shown so people can recognise a key. Comparison is constant time.
- A key acts as the person who created it, limited to its scopes. If that person is suspended or leaves, or loses a permission, the key loses it too. The guard refuses any route whose permission is not in the key's scopes (403), and any route with no permission at all. Invalid, revoked or expired keys get 401.
- Scopes are read-only permissions that do not need two-step verification: `org:read`, `employees:read`, `leave:read`, `attendance:read`, `shifts:read`, `requisitions:read`, `candidates:read`, `learning:read`, `performance:read`, `announcements:read`, `reports:read`, `audit:read`.
- A database trigger keeps a revoked key revoked and stops the scopes, owner, prefix or hash from changing. Last use is recorded at most once a minute. Creating and revoking are audited; requests made with a key are labelled with the key in the audit trail.

### Outgoing webhooks (`webhooks.service.ts`, `safe-http.ts`)
- Events: `employee.created`, `employee.changed`, `employee.job_changed`, `employee.confirmed`, `employee.exit_scheduled`, `employee.exit_withdrawn`, `employee.exited` (new), `leave.requested`, `leave.approved`, `helpdesk.case_created` (never confidential cases), `payroll.run_finalised` (new), plus `workflow.webhook` from workflow steps and `webhook.test`.
- Body `{ id, type, createdAt, workspaceId, data }`; `data` holds only each event's allow-listed keys. Headers `crew-signature: t=<unix>,v1=<HMAC-SHA256 hex of "t.body">`, `crew-event`, `crew-delivery`. Receivers should reject signatures older than 5 minutes and use `id` to ignore repeats.
- Delivery: one per endpoint per event (unique key). A timer every 2 seconds claims due deliveries with row locking, so several API instances can run. A 2xx within 10 seconds succeeds. Otherwise retries after 1 minute, 5 minutes, 30 minutes, 2 hours and 10 hours (6 attempts), then the delivery fails and can be sent again. Fifteen failed attempts in a row switch the endpoint off and notify its creator. Endpoints only receive events that happened after they were created.
- Safety: addresses must be `https://`, without a user name or password, and not private, loopback, link-local or carrier-grade NAT addresses. The check is repeated on the address actually connected to (so DNS cannot point a public name at an internal service). Redirects are not followed and only the first 2 KB of a response is kept. `INTEGRATIONS_ALLOW_PRIVATE_URLS=true` lifts this for local development and tests and is refused in staging and production.
- Signing secrets are encrypted with `FIELD_ENCRYPTION_KEY` and shown once (on creation and on rotation).

### Slack (`connections.service.ts`)
- The incoming webhook URL must look like `https://hooks.slack.com/services/T…/B…/…`. It is encrypted at rest and only its last 6 characters are shown.
- Every call is logged (action, result, Slack's short reason, time taken). Slack's "this webhook was removed" answers mark the connection as not working; rate limits and server errors are retried by the workflow.

### Workflow steps
- **Post to Slack**: a connection and a message with `{{field}}` values. Test runs describe it without posting.
- **Send to a webhook**: an endpoint and a short message; sends a signed `workflow.webhook` event with the run's values. One delivery per run and step however often the step is retried.
- Deleting an endpoint or disconnecting Slack is refused while an active workflow uses it.

### Web Portal
- Settings, Integrations (owners): the integrations page, API keys, Webhooks (list, endpoint page with delivery log and settings, delivery page), Slack. The Automation Studio editor has the two new steps.

## Tests
- API: `apps/api/test/integrations.spec.ts` (13 tests: permissions, plan and two-step verification; keys; webhooks; Slack; workflow steps; failures). Full API suite 228 tests.
- Shared rules: `packages/contracts/src/integrations.spec.ts` (payload allow-list, key format, scopes, input checks, workflow step checks). 108 tests in all.
- Browser: `pnpm e2e:integrations` (run on a fresh database; see the header of `e2e/integrations-flow.cjs`). Runs in CI.
