import { z } from 'zod';
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
  planKey: z.enum(['starter', 'professional', 'business', 'enterprise']),
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
