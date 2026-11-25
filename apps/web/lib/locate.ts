/**
 * The browser's location for a check-in, check-out or location update: read once when the person presses the button,
 * never tracked in the background. A refusal or a timeout comes back as a status, so the punch is still recorded and the
 * day waits for verification instead of being guessed as home.
 */
export type LocationStatus = 'ok' | 'denied' | 'unavailable' | 'timeout';
export interface PunchLocation { latitude?: number; longitude?: number; accuracyM?: number; locationStatus: LocationStatus }

export function locateOnce(timeoutMs = 10_000): Promise<PunchLocation> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve({ locationStatus: 'unavailable' });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy), locationStatus: 'ok' }),
      (err) => resolve({ locationStatus: err.code === err.PERMISSION_DENIED ? 'denied' : err.code === err.TIMEOUT ? 'timeout' : 'unavailable' }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

/** Whether a punch needs the location: office and home attendance is on, or the workplace checks a geofence. */
export function needsLocation(today: { geofence: { mode: string; configured: boolean }; workMode?: { enabled: boolean } | null }) {
  return Boolean(today.workMode?.enabled) || (today.geofence.mode !== 'off' && today.geofence.configured);
}

/** The location for a punch, or a refusal message when the workplace insists on it. */
export async function punchLocation(today: { geofence: { mode: string; configured: boolean }; workMode?: { enabled: boolean; requirement?: string } | null }) {
  if (!needsLocation(today)) return { where: {} as Partial<PunchLocation>, refused: null as string | null };
  const where = await locateOnce();
  if (where.locationStatus === 'denied' && (today.geofence.mode === 'enforce' || (today.workMode?.requirement && today.workMode.requirement !== 'none'))) {
    return { where, refused: 'Your workplace checks that you are at the office. Allow location access in your browser and try again.' };
  }
  return { where, refused: null };
}
