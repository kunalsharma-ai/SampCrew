# Phase 8 report: AI copilots, Automation Studio and insights

Phase 8 adds four things:

- **CREW AI** through one gateway: an **HR assistant** for employees that answers only from the workspace's published help articles, and **reply drafts** for HR handlers on helpdesk cases.
- **Automation Studio**: workflows that start when something happens in CREW and run steps in order (condition, notify, wait, ask for approval, assign a course), with tested versions, durable runs and a step-by-step trace. Workflows can be drafted with AI.
- **Attrition risk**: a daily, rule-based score per person with the named signals behind it, for HR only.
- **Payroll checks before approval**: each person's pay in a run compared with their own last finalised months.

Plan features: AI needs `ai_copilot` (Business and Enterprise), Automation Studio needs `automation` (Professional and up), attrition risk needs `workforce_analytics` (Business and up). Payroll checks come with `payroll`.

AI output is always a draft or a suggestion for a person to check. Nothing an AI writes is sent, saved or acted on without a person doing it.

## Working end to end, and not yet

### Working end to end
Each item below runs against the real API and PostgreSQL, is covered by automated tests, and by a browser flow where it has screens. The AI provider in these tests is a **local test stub** (`e2e/ai-stub.cjs` in the browser flow, an in-test HTTP server in the API tests) that stands in for the Claude Messages API and returns fixed answers. CREW's side is real: the SDK call, settings, credit limits, redaction, grounding, logging, review before use.

- **AI settings** (owner): provider status, per-feature switches, prompt retention and this month's usage. Switching the assistant off removes it for employees at once. `e2e/ai-flow.cjs`.
- **HR assistant** on the Ask HR page: answers cite the help articles they used, the sources open in place, people mark answers helpful or not. Questions no article covers get "no answer found" **without calling the AI**. Email addresses and other identifiers in the question are removed before sending (checked at the stub). `e2e/ai-flow.cjs`.
- **Reply drafts** on helpdesk cases: HR asks for a draft, edits it, sends it, and the message is marked "Drafted with AI". Not offered on confidential cases. `e2e/ai-flow.cjs`.
- **AI activity log** (auditors): every call with who asked, the redacted request, the answer, sources, tokens, credits, time and feedback; opening one is audited. `e2e/ai-flow.cjs`.
- **Automation Studio**: draft with AI, build or edit steps with checks as you type, save immutable versions, test with sample values (nothing is sent), activate, pause, archive. A live run started by a real leave request asked the operator's manager for approval in Approvals, then notified the operator; the run trace shows each step. `e2e/ai-flow.cjs` and API tests (retries, failures, retry from the failed step, cancel, auto-pause when the owner loses access, idempotency).
- **Attrition risk**: list by band, recalculate, the "how scores work" rules, a person's factors, inputs, history and reviews. Managers are refused. `e2e/ai-flow.cjs` and API tests.
- **Payroll checks**: the "Checks before approval" card on a computed run. API tests cover each check; the card is opened in `e2e/payroll-flow.cjs`.

### Not yet working, or not yet verified
- **No real AI model has been called from CREW.** No API key was available in this build, so every AI test uses the stub. The request shape follows the official Anthropic TypeScript SDK (`@anthropic-ai/sdk`), but answer quality, latency and cost with a real model are not measured yet. Before production: run the assistant and drafts against the real API with a test workspace and review the answers.
- **Refusal fallback is on by default.** With `AI_REFUSAL_FALLBACK=true`, when the model declines a request the Claude API retries it once on its fallback model (server-side beta `server-side-fallback-2026-07-01`). Set it to `false` to turn this off. A request still declined is logged as "Declined by the AI" and the person is told to ask HR.
- **Search is keyword-based** (PostgreSQL full-text search over published articles). There is no vector or semantic search, so a question worded very differently from an article can miss it and get "no answer found".
- **Only one AI provider (the Claude API) is implemented.** Workspaces cannot bring their own key; the provider and key are set once for the installation by environment.
- **Workflows are linear.** No parallel branches, no "if/else" (a condition can only stop the run), no loops, no schedules or date-based triggers, and no actions outside CREW (webhooks come with Phase 9 integrations). Notifying "a chosen person" exists in the API but has no picker in the editor yet.
- **Attrition risk is a set of transparent rules, not a trained model.** It has not been validated against real leavers. It is advisory and should start a conversation, not a decision.
- **Payroll checks** compare only with the same person's earlier finalised months in the same legal entity; a first month has nothing to compare with.
- **The mobile app** has no AI or automation screens yet.

## What was delivered

### AI gateway (`apps/api/src/modules/ai`)
- **One way out.** Every model call goes through `AiGatewayService.complete()`. It checks, in order: a provider is configured, the plan includes `ai_copilot`, the workspace has the feature switched on, and the month's credits are not used up. Then it removes identifiers, calls the model **outside any database transaction**, and records the call.
- **Provider.** `AI_PROVIDER=none` (the default) means nothing is sent anywhere and every AI feature says AI is not set up. `AI_PROVIDER=anthropic` needs `ANTHROPIC_API_KEY`; the API refuses to start without it. The client uses only that key (never other credentials in the environment), a 30-second timeout and two retries for rate limits and server errors. Model `AI_MODEL` (default `claude-opus-5-5`), effort `AI_EFFORT` (default `low`).
- **Redaction** (`packages/contracts/src/ai-redact.ts`) removes email addresses, phone numbers of 10 or more digits, IBANs, card numbers, Indian PAN, IFSC and Aadhaar numbers, UK National Insurance numbers and labelled account numbers, replacing each with a label such as `[email]`. Counts are logged per call. Pay, bank, tax and health fields are never put into a prompt in the first place.
- **Credits.** One credit per thousand tokens (input plus output, rounded up). Plans set the monthly allowance (Professional 500, Business 5,000, Enterprise 50,000). A call over the limit is refused and logged as "Over credit limit".
- **Log.** `ai_interactions` keeps feature, status, provider, model, prompt version, the redacted request, the answer, the sources given, redaction counts, tokens, credits, time, and the person's feedback. Rows cannot be changed except to add feedback and, after the workspace's retention period (7 to 730 days, default 90), to remove the text. The daily HR job does the removal.

### HR assistant and reply drafts
- The assistant searches the workspace's **published** help articles, gives the model the best four with numbers, and tells it to answer only from them and cite them like [1]. It cannot see the person's records. With no matching article, CREW answers itself and no model is called.
- Reply drafts give the model the case thread and up to three matching articles, and ask for a short reply with square-bracket placeholders where the articles do not say. The handler edits and sends; the sent message keeps a link to the AI call. Drafts are refused on confidential cases.

### Automation Studio (`apps/api/src/modules/automation`)
- **Triggers:** an employee record is created; an employee changes job; someone applies for leave; a leave request is approved; a helpdesk case is raised (never confidential ones, and the case text is never available to a workflow).
- **Steps:** continue only if (with is, is not, more or less than, contains, is one of), send a notification (to the employee, their manager or everyone with a role; optional email), wait, ask for approval (the manager or a role; through the normal Approvals inbox), assign a course. Messages can use `{{field}}` values from the trigger. Up to 20 steps.
- **Versions** are immutable. Saving creates a new version; an active workflow keeps running its live version until a new one is tested and activated.
- **Test runs** use sample values, describe what each step would do without doing it, and skip waits. Only a version with a passing test can be activated.
- **Runs as a person.** Activating makes you the workflow's owner. Every step runs with your permissions, `automation:manage` is checked again at every step, and if you lose access or leave, the workflow pauses itself and says why.
- **Durable runs.** Runs start from the outbox (one run per workflow per event, enforced by a unique key), are advanced by a timer every 3 seconds with row claiming so two API instances cannot run the same step, and survive restarts. A failing step is retried after 30 seconds, then 2 minutes (3 attempts), then the run fails and the owner is notified. Failed runs can be retried from the failed step, and runs under way can be cancelled (any pending approval is withdrawn).
- **Draft with AI** turns a plain-English description into a definition, checks it against the same rules as the editor, and loads it into the editor marked as an AI draft. Nothing is saved until the person saves it, and it still needs a passing test.

### Insights (`apps/api/src/modules/insights`)
- **Attrition risk** (rules `attrition-rules-v1`). Points per signal: in their first year 15; three or more years without a promotion or move 20; unplanned leave in the last 90 days at least doubled and 4 or more days 20; late or absent 3 or more days in 30 15; last released rating in the bottom 40% of the scale 20; no recognition in 180 days (after 6 months) 10; two or more pay questions to HR in 90 days 10. Capped at 100; high is 50 or more, medium 25 to 49. Salary amounts, the reasons given for leave, protected characteristics and confidential cases are not used. Scores and their inputs are stored daily; HR records a review outcome (action planned, no action, score not accurate).
- **Payroll checks** flag negative or zero net pay, zero gross, high loss-of-pay days, gross or net more than 20% away from the median of the person's last three finalised months, net pay far outside their own history, and pay components added or removed. Nothing is changed.

### Web Portal screens
- Ask HR: "Ask the HR assistant" panel (when available to the person).
- Helpdesk case: "Draft a reply with AI", the check-and-edit notice and the "Drafted with AI" badge.
- Administration: **AI settings** and **AI activity** (list and call detail).
- Intelligence: **Automation Studio** (list, editor with AI draft, test panel, versions, status), **Workflow runs** (filters, trace, retry, cancel) and **Attrition risk** (list, rules, person page with review form).
- Payroll run: **Checks before approval** card.

### Who can do what
| Permission | Who has it by default | What it allows |
|---|---|---|
| `ai:use` (own) | Everyone | Use the assistant and give feedback on your own AI answers |
| `ai:configure` (needs MFA) | Owner | AI settings and usage |
| `audit:read` | Owner, auditor | AI activity log |
| `helpdesk:manage` | HR | Reply drafts on cases they can handle |
| `automation:manage` (needs MFA) | Owner, HR admin | Automation Studio and runs |
| `insights:attrition` (new, sensitive) | Owner, HR admin | Attrition risk; managers do not have it |
| `payroll:read` (needs MFA) | Payroll, finance | Payroll checks |

## Demo data
- The three AI features are switched on for Northwind (they do nothing until the installation sets a provider).
- An active, tested workflow, "Check in after long sick leave", tells HR admins when someone asks for three or more days of sick leave.
- A new demo user, `hr.ops@demo.crew.local` (Anjali Rao, HR Operations Manager, HR admin role), used by the AI browser flow so it does not depend on the MFA state other flows leave behind.
- Attrition scores are calculated by the daily HR job a few seconds after the API starts.

## Tests
- **Contracts:** 97 unit tests. Phase 8 adds redaction, credits, workflow definition checks (fields, operators, placeholders, roles, duplicate ids), templates, conditions, delays and retry back-off, attrition rules and bands, and payroll checks.
- **API:** 215 integration tests. Phase 8 adds `test/ai-automation.spec.ts` (21) with a local stub of the Messages API, covering:
  - **Gateway:** not configured, not in plan, feature off, credit limit, refusal, provider error, redaction of what is sent, the logged record, feedback on your own calls only, retention purge.
  - **Assistant and drafts:** grounding and citations, no model call without a matching article, confidential cases refused, a sent reply linked to its draft.
  - **Automation:** definition checks, immutable versions, activation only after a passing test, live runs from real events with approval and rejection, idempotency per event, retries then failure, retry from the failed step, cancel, auto-pause when the owner loses permission, confidential cases not triggering.
  - **Insights:** factors from real records, managers refused, views and reviews audited, payroll checks against history.
  - **Isolation** of the new tables by database role and API.
- **Browser:** `e2e/ai-flow.cjs` (7 steps, fails on any browser error) runs on a fresh database against the AI test stub, in its own CI step after the other flows. `e2e/payroll-flow.cjs` now also opens the payroll checks card.

## Security verification
- **Tables:** all 9 new tables have forced Row-Level Security and composite workspace foreign keys. AI calls and workflow versions are protected by triggers (only feedback and the retention purge can change a call; only the tested time can change on a version).
- **Data sent to AI:** identifiers removed, pay, bank, tax and health fields never included, only published articles and non-confidential cases, and nothing at all unless the installation and the workspace both switch AI on.
- **Keys:** the provider key comes only from the environment, is never stored in the database or logged, and the client ignores any other credentials it might find.
- **Automation:** runs act with a real person's permissions, rechecked at every step, with automatic pause; approvals go through the same engine and inbox as everything else.
- **Routes:** every new route declares its permission and plan feature (see [docs/api](../api)).

## Next: Phase 9 (integrations)
As planned in the architecture pack: the integration marketplace, connectors and outgoing webhooks, which will also let workflows act outside CREW.
