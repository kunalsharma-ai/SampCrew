import { z } from 'zod';
import { SYNC_BATCH_MAX } from '../mobile-sync';

export const MOBILE_PLATFORMS = ['ios', 'android', 'web'] as const;

const installationId = z.string().trim().min(16).max(80).regex(/^[A-Za-z0-9_-]+$/);
const runId = z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const deviceRegisterInput = z.object({
  /** Random id the app creates on first start and keeps in secure storage. */
  installationId,
  platform: z.enum(MOBILE_PLATFORMS),
  appVersion: z.string().trim().max(20).default(''),
  model: z.string().trim().max(80).default(''),
  osVersion: z.string().trim().max(40).default(''),
});
export type DeviceRegisterInput = z.infer<typeof deviceRegisterInput>;

/** Expo push tokens look like ExponentPushToken[xxxxxxxx]. Send null to stop push on this device. */
export const pushTokenInput = z.object({
  token: z.string().trim().regex(/^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]{10,200}\]$/, 'Not an Expo push token').nullable(),
});

export const syncPunch = z
  .object({
    /** Per-device counter; with the device id it makes the punch idempotent. */
    sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    direction: z.enum(['in', 'out']).optional(),
    capturedAt: z.iso.datetime({ offset: true }),
    capturedElapsedMs: z.number().min(0).optional(),
    capturedRunId: runId.optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    accuracyM: z.number().min(0).max(100_000).optional(),
    /** The phone reported the location as coming from a mock provider. */
    mockLocation: z.boolean().default(false),
    /** The punch was queued while the phone had no connection. */
    offline: z.boolean().default(false),
    note: z.string().trim().max(300).optional(),
  })
  .refine((v) => (v.latitude === undefined) === (v.longitude === undefined), { message: 'Send both latitude and longitude', path: ['longitude'] });

export const punchSyncInput = z.object({
  deviceId: z.uuid(),
  sentElapsedMs: z.number().min(0).optional(),
  sentRunId: runId.optional(),
  punches: z.array(syncPunch).min(1).max(SYNC_BATCH_MAX),
});
export type PunchSyncInput = z.infer<typeof punchSyncInput>;
