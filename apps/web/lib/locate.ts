/**
 * The browser's location for a check-in, check-out or location update: read once when the person presses the button,
 * never tracked in the background. A refusal or a timeout comes back as a status, so the punch is still recorded and the
 * day waits for verification instead of being guessed as home.
 */
export type LocationStatus = 'ok' | 'denied' | 'unavailable' | 'timeout';
export interface PunchLocation { latitude?: number; longitude?: number; accuracyM?: number; locationStatus: LocationStatus }

/**
 * Reads the location once, as precisely as the device can within the time allowed (issue #89). Laptops often give a
 * first Wi-Fi or IP reading that is too vague and sharpen it over a few seconds, or time out when asked for GPS they do
 * not have; so the readings are watched for up to `timeoutMs`, the best one kept, and it stops as soon as one is precise
 * enough. When nothing comes, a quick low-accuracy reading is tried before giving up.
 */
export function locateOnce(timeoutMs = 12_000, goodEnoughM = 100): Promise<PunchLocation> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve({ locationStatus: 'unavailable' });
    const geo = navigator.geolocation;
    let best: GeolocationPosition | null = null;
    let done = false;
    let watch: number | null = null;
    const finish = (r: PunchLocation) => {
      if (done) return;
      done = true;
      if (watch !== null) geo.clearWatch(watch);
      clearTimeout(timer);
      resolve(r);
    };
    const fromPos = (p: GeolocationPosition): PunchLocation => ({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy), locationStatus: 'ok' });
    const fallback = (status: LocationStatus) => {
      if (best) return finish(fromPos(best));
      if (status === 'denied') return finish({ locationStatus: 'denied' });
      // No precise reading: ask once more for whatever the device knows quickly (network location).
      geo.getCurrentPosition((p) => finish(fromPos(p)), (err) => finish({ locationStatus: err.code === err.PERMISSION_DENIED ? 'denied' : status }), { enableHighAccuracy: false, timeout: 5_000, maximumAge: 120_000 });
    };
    const timer = setTimeout(() => fallback('timeout'), timeoutMs);
    watch = geo.watchPosition(
      (p) => {
        if (!best || p.coords.accuracy < best.coords.accuracy) best = p;
        if (p.coords.accuracy <= goodEnoughM) finish(fromPos(p));
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) return finish({ locationStatus: 'denied' });
        // Unavailable or timed out: keep waiting until our own time is up (a later reading may still come), unless it is the end.
        if (err.code === err.TIMEOUT) fallback('timeout');
      },
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
