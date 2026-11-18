import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { hostOf, resumeSession, type StartupDeps } from './startup';

const TOKENS = { accessToken: 'a', refreshToken: 'r' };
const never = <T>() => new Promise<T>(() => {});

function deps(over: Partial<StartupDeps> = {}): StartupDeps {
  return {
    readTokens: async () => TOKENS,
    clearTokens: vi.fn(async () => {}),
    biometricEnabled: async () => false,
    start: async () => {},
    restore: async () => false,
    apiHost: 'api.example.com',
    timeoutMs: 50,
    ...over,
  };
}

describe('resumeSession', () => {
  it('goes to sign-in on a fresh install', async () => {
    expect(await resumeSession(deps({ readTokens: async () => null }))).toEqual({ status: 'signedOut' });
  });

  it('opens the app when the server answers', async () => {
    expect(await resumeSession(deps())).toEqual({ status: 'ready' });
  });

  it('asks for the biometric when it is turned on, without calling the server', async () => {
    const start = vi.fn(async () => {});
    expect(await resumeSession(deps({ biometricEnabled: async () => true, start }))).toEqual({ status: 'locked' });
    expect(start).not.toHaveBeenCalled();
  });

  it('clears an unreadable saved sign-in and goes to sign-in instead of hanging', async () => {
    const d = deps({ readTokens: async () => { throw new Error('Could not decrypt the value'); } });
    const r = await resumeSession(d);
    expect(r.status).toBe('signedOut');
    expect(r.notice).toMatch(/could not be read/);
    expect(d.clearTokens).toHaveBeenCalled();
  });

  it('still settles when the keystore never answers', async () => {
    expect((await resumeSession(deps({ readTokens: never }))).status).toBe('signedOut');
  });

  it('stays locked if the biometric setting cannot be read', async () => {
    expect(await resumeSession(deps({ biometricEnabled: async () => { throw new Error('storage'); } }))).toEqual({ status: 'locked' });
  });

  it('goes to sign-in with a message when the session has ended', async () => {
    const r = await resumeSession(deps({ start: async () => { throw new ApiError(401, 'signed_out', 'x'); } }));
    expect(r).toEqual({ status: 'signedOut', notice: 'Your session has ended. Please sign in again.' });
  });

  it('works from the stored copy when offline', async () => {
    const r = await resumeSession(deps({ start: async () => { throw new ApiError(0, 'offline', 'x'); }, restore: async () => true }));
    expect(r).toEqual({ status: 'ready' });
  });

  it('names the server when offline with nothing stored', async () => {
    const r = await resumeSession(deps({ start: async () => { throw new ApiError(0, 'offline', 'x'); } }));
    expect(r.status).toBe('signedOut');
    expect(r.notice).toMatch(/Could not reach SampCrew at api\.example\.com/);
  });

  it('does not wait for ever on a server that never answers', async () => {
    const restore = vi.fn(async () => true);
    expect(await resumeSession(deps({ start: never, restore }))).toEqual({ status: 'ready' });
    expect(restore).toHaveBeenCalled();
    const r = await resumeSession(deps({ start: never }));
    expect(r.status).toBe('signedOut');
    expect(r.notice).toMatch(/did not answer at api\.example\.com in time/);
  });

  it('goes to sign-in when the stored copy is broken', async () => {
    const r = await resumeSession(deps({ start: async () => { throw new ApiError(0, 'offline', 'x'); }, restore: async () => { throw new SyntaxError('bad json'); } }));
    expect(r.status).toBe('signedOut');
  });

  it('reports any other failure instead of hanging', async () => {
    const r = await resumeSession(deps({ start: async () => { throw new TypeError('boom'); } }));
    expect(r.status).toBe('signedOut');
    expect(r.notice).toMatch(/could not start: boom/);
  });
});

describe('hostOf', () => {
  it('keeps only the host', () => {
    expect(hostOf('https://api.example.com/x')).toBe('api.example.com');
    expect(hostOf('http://192.168.1.5:4000')).toBe('192.168.1.5:4000');
  });
});
