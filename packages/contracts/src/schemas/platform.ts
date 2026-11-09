import { z } from 'zod';
import { LIMIT_KEYS } from '../features';
import { planKey } from './billing';
import { email, name, slug } from './common';

export const platformLoginRequest = z.object({
  email: email,
  password: z.string().min(1).max(200),
  code: z.string().regex(/^\d{6}$/).optional(),
});

export const platformTenantStatusRequest = z.object({
  status: z.enum(['active', 'suspended']),
  reason: z.string().trim().min(5).max(500),
});

export const platformCreateTenantRequest = z.object({
  companyName: name,
  slug,
  ownerEmail: email,
  ownerName: name,
  planKey: planKey,
  seats: z.number().int().min(1),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  timezone: z.string().min(1),
  trialDays: z.number().int().min(0).max(90).default(14),
});

export const supportAccessRequest = z.object({
  reason: z.string().trim().min(10).max(500),
  durationMinutes: z.number().int().min(15).max(480),
});

export const planPriceUpdate = z.object({
  currency: z.enum(['USD', 'INR']),
  monthly: z.string().regex(/^\d+(\.\d{1,2})?$/),
  annualPerMonth: z.string().regex(/^\d+(\.\d{1,2})?$/),
});

const featureKey = z.string().regex(/^[a-z][a-z0-9_]*$/);
const limitValue = z.number().int().min(-1).max(10_000_000);
const planDetails = {
  name: z.string().trim().min(2).max(60),
  tagline: z.string().trim().max(200),
  minimumSeats: z.number().int().min(1).max(100_000),
  quoteOnly: z.boolean(),
  /** Shown to workspace admins on Plan & billing; hidden plans are assigned by SAMPLEDGE only. */
  isPublic: z.boolean(),
  sortOrder: z.number().int().min(0).max(1000),
};

/** SAMPLEDGE creates a plan; it starts with a copy of another plan's features, limits and prices, or with only the foundation. */
export const planCreate = z.object({
  key: planKey,
  ...planDetails,
  copyFrom: planKey.optional(),
}).strict().partial({ tagline: true, minimumSeats: true, quoteOnly: true, isPublic: true, sortOrder: true });

export const planUpdate = z.object(planDetails).strict().partial();

/** The full set of modules and limits a plan includes. Replaces what the plan had. */
export const planEntitlementsUpdate = z.object({
  features: z.array(featureKey).max(200),
  limits: z.partialRecord(z.enum(LIMIT_KEYS as [string, ...string[]]), limitValue),
}).strict();

export type PlanCreate = z.infer<typeof planCreate>;
export type PlanUpdate = z.infer<typeof planUpdate>;
export type PlanEntitlementsUpdate = z.infer<typeof planEntitlementsUpdate>;

/** A workspace admin asks SAMPLEDGE for a plan they cannot switch to themselves (quote-only or hidden). */
export const planRequestCreate = z.object({
  planKey: planKey,
  seats: z.number().int().min(1).max(1_000_000),
  billingCycle: z.enum(['monthly', 'annual']),
  message: z.string().trim().max(1000).optional(),
}).strict();

export const planRequestDecision = z.object({
  decision: z.enum(['approved', 'declined']),
  note: z.string().trim().max(500).optional(),
}).strict();
