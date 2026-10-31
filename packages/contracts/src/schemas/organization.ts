import { z } from 'zod';
import { code, countryCode, currencyCode, name, timezone } from './common';

export const legalEntityInput = z.object({
  name,
  legalName: z.string().trim().max(200).optional(),
  countryCode,
  currency: currencyCode,
  timezone,
  registrationNumber: z.string().trim().max(64).optional(),
  taxId: z.string().trim().max(64).optional(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(4),
  address: z.string().trim().max(500).optional(),
});
export type LegalEntityInput = z.infer<typeof legalEntityInput>;

export const businessUnitInput = z.object({ name, code: code.optional(), description: z.string().max(500).optional() });

export const locationInput = z
  .object({
    name,
    code: code.optional(),
    legalEntityId: z.uuid(),
    timezone,
    addressLine: z.string().trim().max(300).optional(),
    city: z.string().trim().max(100).optional(),
    region: z.string().trim().max(100).optional(),
    countryCode,
    postalCode: z.string().trim().max(20).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    geofenceRadiusM: z.number().int().min(25).max(5000).optional(),
    kind: z.enum(['office', 'branch', 'factory', 'warehouse', 'store', 'hospital', 'site', 'remote_hub']).default('office'),
  })
  .refine((v) => (v.latitude === undefined) === (v.longitude === undefined), {
    message: 'Provide both latitude and longitude, or neither',
    path: ['longitude'],
  })
  .refine((v) => v.geofenceRadiusM === undefined || v.latitude !== undefined, {
    message: 'A geofence needs coordinates',
    path: ['geofenceRadiusM'],
  });

export const departmentInput = z.object({
  name,
  code: code.optional(),
  parentId: z.uuid().nullable().optional(),
  legalEntityId: z.uuid().nullable().optional(),
  businessUnitId: z.uuid().nullable().optional(),
  headMembershipId: z.uuid().nullable().optional(),
});
export type DepartmentInput = z.infer<typeof departmentInput>;

export const tenantSettingsInput = z.object({
  name: name.optional(),
  timezone: timezone.optional(),
  currency: currencyCode.optional(),
  locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  requireMfa: z.boolean().optional(),
});
