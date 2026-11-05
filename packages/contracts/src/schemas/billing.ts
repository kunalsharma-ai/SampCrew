import { z } from 'zod';

export const changeSubscriptionRequest = z.object({
  planKey: z.enum(['starter', 'professional', 'business', 'enterprise']),
  billingCycle: z.enum(['monthly', 'annual']),
  seats: z.number().int().min(1).max(1_000_000),
  currency: z.enum(['USD', 'INR']).optional(),
});
export type ChangeSubscriptionRequest = z.infer<typeof changeSubscriptionRequest>;

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'cancelled', 'suspended'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
