# Phase 21 report: advanced billing with Razorpay and Stripe

Kunal asked (10 November 2026) for the advanced billing features proposed after phase 19, with payment platforms connected by API key so they can be switched on later and work straight away. Razorpay and Stripe keys are typed into **Console > Integrations**. Nothing is read from the server's environment, and nothing needs a redeploy.

## How to switch on online payment

1. In the Razorpay or Stripe dashboard, create API keys and add a webhook. Use the address shown on the Integrations card, which is `https://<api host>/api/v1/billing/webhooks/razorpay` or `.../stripe`.
2. In **Console > Integrations**, open Razorpay or Stripe and paste the keys and the webhook secret. Press **Test connection**, switch it on and save. Keys are stored encrypted. Only their last characters are ever shown again.
3. In **Console > Billing & revenue > Settings**, choose the gateway for each currency (INR uses Razorpay and USD uses Stripe by default). Then fill in SAMPLEDGE's seller details and GSTIN.

Until a gateway is set up for a workspace's currency, everything works as before: a plan change applies at once and the invoice is paid by bank transfer, which billing staff record with **Mark paid**.

## Working end to end

### Payments
- **Checkout.** An upgrade, an add-on or an open invoice goes to a Razorpay payment link or a Stripe Checkout page. The change is applied only when the gateway's signed webhook confirms the payment.
- **Webhook checks.** The signature is checked: HMAC for Razorpay, and `Stripe-Signature` with a 5-minute tolerance for Stripe. The amount and currency must match the order, and replays are ignored. Bad signatures are refused and recorded in Platform audit.
- **Saved cards.** Stripe saves the card, and renewals then charge it automatically. A declined card leaves the invoice open and notifies the billing admins.
- **Razorpay renewals** get an invoice with a **Pay now** button. Automatic Razorpay debits (mandates) are not built yet.

### GST invoices and proration
- **Invoice numbers** look like `SC2627-000123`, which fits within GST's 16 characters.
- **Tax:**
  - CGST and SGST when the customer is in the same state as SAMPLEDGE.
  - IGST when the customer is in another Indian state.
  - Zero-rated with the LUT note for exports.
  - A configurable tax for other countries.
- **PDF tax invoice.** Each invoice has a PDF showing both GSTINs, the SAC code and the place of supply.
- **Upgrades** are charged only for the days left, minus the unused part of the old plan.
- **Downgrades and annual-to-monthly moves** wait for the end of the period, and the scheduled change can be cancelled.
- **Monthly-to-annual moves** apply at once.

### Unpaid invoices
- **Reminders** go out on set days after the due date: 1, 3 and 7 by default.
- **Read-only lock.** After the grace period (14 days by default), the workspace becomes read-only:
  - Every change is refused with `402 workspace_read_only`.
  - Viewing, signing in and Plan & billing still work, so the invoice can be paid.
  - A banner tells everyone why.
- **Unlocking.** Paying the invoice or **Mark paid** lifts the lock at once. The Console can also lift it for 7 days while a transfer is on its way.

### Add-ons
- The Console has a catalogue of modules and extra capacity: employees, AI credits and storage.
- Workspaces buy add-ons on Plan & billing and pay for the rest of the period. Renewals include them.
- Removing an add-on takes effect at the next renewal.

### Trials
- Each plan has its own trial days, and optionally only some of its modules during the trial.
- A workspace can try a plan once. Reminders go out before the end.
- At the end, the workspace goes back to its paid plan, or the first period is invoiced for a sign-up trial.
- Billing admins see modules missing from their plan in the navigation with a lock. The lock opens Plan & billing with the plans and add-ons that include that module.

### Usage
- Plan & billing shows meters for employees, AI credits this month and storage.
- Billing admins are notified once at 80% and once at 100% of a limit.
- For each limit and plan, SAMPLEDGE chooses one of two behaviours:
  - **Stop at the limit**, as today.
  - **Go on and bill the extra**, with an overage line on the next renewal invoice.

### Coupons, partners and contract deals
- **Coupons** take a percent or an amount off once, for a number of invoices, or forever. They can be limited to some plans, a maximum number of uses or an end date, and can carry a partner name.
- **Contract terms** for one workspace set a price per seat, a discount and extra modules until an end date. They are set from the workspace's **Billing** tab in the Console.

### Revenue
**Console > Billing & revenue** has six tabs:
- **Revenue:**
  - MRR and ARR per currency.
  - MRR movements over 30 days: new, trials converted, upgrades, add-ons, downgrades, cancellations.
  - Churn and trial conversion.
  - Money collected per month and money outstanding.
  - MRR per plan.
  - Demo workspaces are left out.
- **Invoices**, with Mark paid, Void and PDF.
- **Add-ons.**
- **Coupons.**
- **Settings.**
- **Payment events.**

## Tests
- **`apps/api/test/billing-payments.spec.ts`** has 18 tests against the Razorpay and Stripe stand-in. They cover:
  - Gateway setup.
  - Webhook rejection.
  - A Razorpay upgrade with exact GST and proration amounts.
  - Scheduled downgrade and renewal.
  - Stripe saved-card renewals and declines.
  - Reminders, lock and unlock.
  - Add-ons, trials, usage and overage.
  - Coupons, deals and revenue.
- **`packages/contracts/src/billing-math.spec.ts`** has 13 tests of the money arithmetic.
- **`e2e/billing-flow.cjs`** (`pnpm e2e:billing`, run in CI) drives the real Console and Web Portal in Chromium:
  - Razorpay keys are tested and saved.
  - The seller GSTIN and an add-on are set.
  - The owner buys the trial plan for ₹677,980.80 with CGST and SGST on the Razorpay page, and the GST invoice PDF is produced.
  - An invoice issued by hand is paid online.
- **`e2e/payments-stub.cjs`** is the stand-in for the Razorpay and Stripe APIs. It is a test stub, not a payment provider.
- **Other checks.** The full API suite (465 tests) and the data-layer engine tests pass. The plans, super admin, platform integrations, web smoke and accessibility browser flows pass after this change.

## Not yet working
- **No real keys tested.** Nothing has been run with real Razorpay or Stripe keys; everything ran against the local stand-in. The first real setup should start in test mode (`rzp_test_` or `sk_test_` keys).
- **No automatic Razorpay renewals.** Razorpay renewals are not charged automatically, because Razorpay mandates and subscriptions are not used. Customers pay each renewal invoice online.
- **Storage overage is not blocked.** When storage is set to "Stop at the limit", uploads are not refused at the limit. Only the warnings and overage billing work.
- **No credit notes or refunds.** Voiding is the only correction.
- **Mobile app.** It shows no billing screens; billing is done on the web.
