import { z } from 'zod';
import { PLAN_KEY_PATTERN } from '../features';

export const planKey = z.string().regex(PLAN_KEY_PATTERN, 'Lower-case letters, digits and underscores');

export const changeSubscriptionRequest = z.object({
  planKey: planKey,
  billingCycle: z.enum(['monthly', 'annual']),
  seats: z.number().int().min(1).max(1_000_000),
  currency: z.enum(['USD', 'INR']).optional(),
});
export type ChangeSubscriptionRequest = z.infer<typeof changeSubscriptionRequest>;

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'cancelled', 'suspended'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

const money = z.string().regex(/^\d{1,11}(\.\d{1,2})?$/, 'Enter an amount such as 499 or 499.50');
const percent = z.string().regex(/^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/, 'Enter a percentage from 0 to 100');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const gstin = z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'A GSTIN has 15 characters, such as 27AAPFU0939F1ZV');
const stateCode = z.string().regex(/^\d{2}$/, 'Choose a state');
const countryCode = z.string().regex(/^[A-Z]{2}$/);
const couponCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,40}$/, 'Codes use letters, digits, - and _');
const featureKey = z.string().regex(/^[a-z][a-z0-9_]*$/);
const addonKey = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Lower-case letters, digits and underscores');

/** A plan change from Plan & billing, with an optional coupon. */
export const checkoutRequest = changeSubscriptionRequest.extend({ couponCode: couponCode.optional() }).strict();
export type CheckoutRequest = z.infer<typeof checkoutRequest>;

/** The workspace's billing details, printed on invoices. A GSTIN makes the invoice a B2B tax invoice. */
export const billingProfileInput = z.object({
  legalName: z.string().trim().min(2).max(160),
  gstin: z.union([z.literal(''), gstin]).optional(),
  addressLine1: z.string().trim().min(3).max(200),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(2).max(80),
  /** Required in India: decides between CGST + SGST and IGST. */
  stateCode: z.union([z.literal(''), stateCode]).optional(),
  postalCode: z.string().trim().min(3).max(12),
  countryCode,
  email: z.email().max(200),
}).strict().superRefine((v, ctx) => {
  if (v.countryCode === 'IN' && !v.stateCode) ctx.addIssue({ code: 'custom', path: ['stateCode'], message: 'Choose your state' });
  if (v.gstin && v.countryCode !== 'IN') ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'A GSTIN is only for businesses in India' });
  if (v.gstin && v.stateCode && v.gstin.slice(0, 2) !== v.stateCode) ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'The GSTIN belongs to a different state than the one chosen' });
});
export type BillingProfileInput = z.infer<typeof billingProfileInput>;

export const addonPurchase = z.object({ addonKey, quantity: z.number().int().min(1).max(1000) }).strict();
export const trialStart = z.object({ planKey }).strict();
export const couponCheck = z.object({ code: couponCode, planKey: planKey.optional() }).strict();
export const renewalSettings = z.object({
  /** Renew at the end of each period (true) or stop at the end of this one (false). */
  autoRenew: z.boolean(),
}).strict();

// ---------------------------------------------------------------------------------------------------------------
// Super Admin Console
// ---------------------------------------------------------------------------------------------------------------

export const BILLING_CURRENCIES = ['INR', 'USD'] as const;
export const GATEWAY_CHOICES = ['razorpay', 'stripe', 'none'] as const;

/** How SAMPLEDGE bills: who issues invoices, tax, payment terms, reminders and the read-only lock. */
export const billingSettingsInput = z.object({
  seller: z.object({
    legalName: z.string().trim().min(2).max(160),
    addressLine1: z.string().trim().min(3).max(200),
    addressLine2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(2).max(80),
    stateCode: z.union([z.literal(''), stateCode]).optional(),
    postalCode: z.string().trim().min(3).max(12),
    countryCode,
    gstin: z.union([z.literal(''), gstin]).optional(),
    pan: z.union([z.literal(''), z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'A PAN has 10 characters, such as AAPFU0939F')]).optional(),
    email: z.email().max(200),
    /** Service code printed on each line (SAC 998314: IT infrastructure and network management, the usual SaaS code). */
    sac: z.string().trim().regex(/^\d{4,8}$/).default('998314'),
  }).strict(),
  /** Invoice numbers look like PREFIX/2026-27/000123 (GST allows 16 characters). */
  invoicePrefix: z.string().trim().regex(/^[A-Z0-9]{1,5}$/, 'Up to 5 capital letters or digits'),
  gstRate: percent,
  exportZeroRated: z.boolean(),
  otherTaxRate: percent,
  otherTaxLabel: z.string().trim().max(30),
  /** Days a workspace has to pay an invoice. */
  paymentTermsDays: z.number().int().min(0).max(90),
  /** Days after the due date on which a reminder is sent. */
  reminderDays: z.array(z.number().int().min(0).max(90)).max(6),
  /** Days after the due date when an unpaid workspace becomes read-only. */
  graceDays: z.number().int().min(1).max(120),
  lockAfterGrace: z.boolean(),
  /** Days before a trial ends on which the admins are reminded. */
  trialReminderDays: z.array(z.number().int().min(0).max(60)).max(6),
  /** Which gateway collects payments in each currency. */
  gateways: z.record(z.enum(BILLING_CURRENCIES), z.enum(GATEWAY_CHOICES)),
}).strict();
export type BillingSettingsInput = z.infer<typeof billingSettingsInput>;

const addonPrice = z.object({ currency: z.enum(BILLING_CURRENCIES), monthly: money, annualPerMonth: money }).strict();

/** Something a workspace can buy on top of its plan: a module, or more of a limit (seats, AI credits, storage). */
export const addonCreate = z.object({
  key: addonKey,
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional(),
  kind: z.enum(['module', 'limit']),
  /** The module (kind module) or the limit it raises (kind limit). */
  featureKey,
  /** For a limit: how much one unit adds (for example 1000 AI credits, 50 GB, 10 employees). */
  unitQuantity: z.number().int().min(1).max(10_000_000).default(1),
  prices: z.array(addonPrice).min(1).max(5),
  /** Plans it can be bought on; empty means every plan. */
  planKeys: z.array(planKey).max(50).default([]),
  isPublic: z.boolean().default(true),
}).strict();
export const addonUpdate = addonCreate.omit({ key: true, kind: true, featureKey: true }).partial().extend({ archived: z.boolean().optional() }).strict();
export type AddonCreate = z.infer<typeof addonCreate>;
export type AddonUpdate = z.infer<typeof addonUpdate>;

export const couponCreate = z.object({
  code: couponCode,
  name: z.string().trim().min(2).max(80),
  kind: z.enum(['percent', 'amount']),
  /** A percentage (kind percent) or an amount off each invoice in `currency` (kind amount). */
  value: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/),
  currency: z.enum(BILLING_CURRENCIES).optional(),
  /** once: the first invoice; repeating: the next `cycles` invoices; forever: every invoice. */
  duration: z.enum(['once', 'repeating', 'forever']),
  cycles: z.number().int().min(1).max(36).optional(),
  planKeys: z.array(planKey).max(50).default([]),
  maxRedemptions: z.number().int().min(1).max(1_000_000).optional(),
  validUntil: isoDate.optional(),
  /** A partner or reseller this code belongs to, shown in the revenue report. */
  partner: z.string().trim().max(80).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.kind === 'percent' && Number(v.value) > 100) ctx.addIssue({ code: 'custom', path: ['value'], message: 'At most 100%' });
  if (v.kind === 'amount' && !v.currency) ctx.addIssue({ code: 'custom', path: ['currency'], message: 'Choose the currency of the amount' });
  if (v.duration === 'repeating' && !v.cycles) ctx.addIssue({ code: 'custom', path: ['cycles'], message: 'How many invoices it applies to' });
});
export const couponUpdate = z.object({ active: z.boolean() }).strict();
export type CouponCreate = z.infer<typeof couponCreate>;

/** A contract agreed with one workspace: its own price per seat, a discount, extra modules, until an end date. */
export const dealInput = z.object({
  unitPrice: money.nullable().optional(),
  discountPercent: percent.nullable().optional(),
  features: z.array(featureKey).max(100).default([]),
  endsOn: isoDate.nullable().optional(),
  partner: z.string().trim().max(80).optional(),
  note: z.string().trim().max(500).optional(),
}).strict();
export type DealInput = z.infer<typeof dealInput>;

/** Trials and what happens beyond a limit, per plan. */
export const planBillingUpdate = z.object({
  trialDays: z.number().int().min(0).max(90),
  /** Modules available during the trial; empty means the whole plan. */
  trialFeatures: z.array(featureKey).max(200),
  /**
   * Per limit: 'block' stops at the limit; 'overage' lets the workspace go beyond it and bills each extra unit at the
   * end of the period at the given price per unit (per employee, per AI credit, per GB).
   */
  overage: z.partialRecord(z.enum(['max_employees', 'ai_credits_monthly', 'storage_gb']), z.object({
    policy: z.enum(['block', 'overage']),
    prices: z.partialRecord(z.enum(BILLING_CURRENCIES), z.string().regex(/^\d{1,7}(\.\d{1,4})?$/)).default({}),
  }).strict()),
}).strict();
export type PlanBillingUpdate = z.infer<typeof planBillingUpdate>;

export const invoiceMarkPaid = z.object({ reference: z.string().trim().min(2).max(120), paidOn: isoDate.optional() }).strict();
export const invoiceVoid = z.object({ reason: z.string().trim().min(5).max(300) }).strict();
export const manualInvoice = z.object({
  description: z.string().trim().min(3).max(200),
  amount: money,
  currency: z.enum(BILLING_CURRENCIES),
}).strict();

/** The default billing settings until SAMPLEDGE saves its own. */
export const DEFAULT_BILLING_SETTINGS: BillingSettingsInput = {
  seller: { legalName: 'SAMPLEDGE', addressLine1: 'Set your registered address in Console > Billing > Settings', city: 'Mumbai', stateCode: '27', postalCode: '400001', countryCode: 'IN', gstin: '', pan: '', email: 'billing@sampledge.com', sac: '998314' },
  invoicePrefix: 'SC',
  gstRate: '18',
  exportZeroRated: true,
  otherTaxRate: '0',
  otherTaxLabel: 'Tax',
  paymentTermsDays: 7,
  reminderDays: [1, 3, 7],
  graceDays: 14,
  lockAfterGrace: true,
  trialReminderDays: [7, 3, 1],
  gateways: { INR: 'razorpay', USD: 'stripe' },
};
