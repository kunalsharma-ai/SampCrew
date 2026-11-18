import { ApiError, type Tokens } from './api';

/**
 * Decides where the app opens: sign-in, the lock screen or the app itself. It always gives an answer within a few
 * seconds, whatever happens. While it is working the app shows its starting screen; if this ever hung or threw,
 * the phone would sit on the splash screen for good, which is what happened on real Android phones before.
 */
export type StartupStatus = 'signedOut' | 'locked' | 'ready';

export interface StartupResult {
  status: StartupStatus;
  /** Shown on the sign-in screen when the app had to send the person there. */
  notice?: string;
}

export interface StartupDeps {
  readTokens(): Promise<Tokens | null>;
  clearTokens(): Promise<void>;
  biometricEnabled(): Promise<boolean>;
  /** Loads who I am from the server and registers this phone. */
  start(): Promise<void>;
  /** Uses who I was last time (offline). False when nothing is stored. */
  restore(): Promise<boolean>;
  /** The server's address, named in the message when it cannot be reached. */
  apiHost: string;
  /** How long to wait for the server before carrying on without it. */
  timeoutMs?: number;
}

export const STARTUP_TIMEOUT_MS = 12_000;

class StartupTimeout extends Error {}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StartupTimeout()), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function hostOf(url: string) {
  return url.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
}

export async function resumeSession(d: StartupDeps): Promise<StartupResult> {
  const timeoutMs = d.timeoutMs ?? STARTUP_TIMEOUT_MS;

  let tokens: Tokens | null;
  try {
    tokens = await within(d.readTokens(), timeoutMs);
  } catch {
    // The phone's keystore could not read the saved sign-in (for example after the app was reinstalled or the
    // phone's screen lock changed). It cannot be repaired, so start again from sign-in.
    await d.clearTokens().catch(() => {});
    return { status: 'signedOut', notice: 'Please sign in again. The saved sign-in on this phone could not be read.' };
  }
  if (!tokens) return { status: 'signedOut' };

  try {
    if (await within(d.biometricEnabled(), timeoutMs)) return { status: 'locked' };
  } catch {
    // If the setting cannot be read, stay on the safe side and ask for the biometric (Sign out is on that screen too).
    return { status: 'locked' };
  }

  try {
    await within(d.start(), timeoutMs);
    return { status: 'ready' };
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      return { status: 'signedOut', notice: 'Your session has ended. Please sign in again.' };
    }
    // Offline, the server is slow or down: keep the session and work from what is stored; screens retry.
    try {
      if (await d.restore()) return { status: 'ready' };
    } catch {
      /* the stored copy is unreadable: fall through to sign-in */
    }
    const why =
      e instanceof StartupTimeout
        ? `SampCrew did not answer at ${d.apiHost} in time.`
        : e instanceof ApiError && e.offline
          ? `Could not reach SampCrew at ${d.apiHost}.`
          : `SampCrew could not start: ${(e as Error)?.message ?? 'unknown error'}.`;
    return { status: 'signedOut', notice: `${why} Check your connection and sign in again.` };
  }
}
