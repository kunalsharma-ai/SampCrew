import type { LoginResponse, MeResponse } from '@crew/contracts';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as ExpoDevice from 'expo-device';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as WebBrowser from 'expo-web-browser';
import { AppState, Platform } from 'react-native';
import { Api, ApiError } from './api';
import { biometricEnabled, unlockWithBiometric } from './biometric';
import { clock, randomId } from './clock';
import { type FlushOutcome, Outbox, type PunchDraft, type QueuedPunch, type RefusedPunch } from './outbox';
import { makePkce, readHandoff } from './sso';
import { kv, secret, tokenStore } from './storage';

export const API_URL: string = ((Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? 'http://localhost:4000').replace(/\/$/, '');

/** Lock again with the biometric after the app has been in the background this long. */
const RELOCK_AFTER_MS = 5 * 60_000;
const INSTALLATION = 'crew.installationId';
const CACHE = 'crew.session.cache';

/** Where the browser preview keeps the PKCE verifier while the identity provider has the tab. */
const SSO_VERIFIER = 'crew.sso.verifier';

/** The app's address the Web Portal sends the browser back to (it must be on the API's MOBILE_SSO_REDIRECTS list). */
export function ssoReturnAddress() {
  return Platform.OS === 'web' ? `${window.location.origin}/sso` : 'crew://sso';
}

export type SignInStep =
  | { step: 'done' }
  | { step: 'redirected' }
  | { step: 'cancelled' }
  | { step: 'mfa'; mfaToken: string }
  | { step: 'workspace'; selectToken: string; workspaces: { id: string; name: string; slug: string }[] };

export interface Device {
  id: string;
  pushEnabled: boolean;
}

export interface QueueState {
  pending: QueuedPunch[];
  refused: RefusedPunch[];
  syncing: boolean;
  last?: FlushOutcome & { at: number };
}

type Status = 'loading' | 'signedOut' | 'locked' | 'ready';

interface SessionValue {
  status: Status;
  api: Api;
  me: MeResponse | null;
  device: Device | null;
  queue: QueueState;
  /** Message shown on the sign-in screen after the session ended on its own. */
  notice: string | null;
  can(permission: string): boolean;
  hasFeature(feature: string): boolean;
  signIn(email: string, password: string, workspace?: string): Promise<SignInStep>;
  /** Single sign-on through the workspace's identity provider, in the system browser. */
  signInWithSso(email: string): Promise<SignInStep>;
  /** Browser preview: finishes single sign-on when the tab comes back to /sso with the code. */
  finishSso(code: string): Promise<SignInStep>;
  verifyMfa(mfaToken: string, code: string): Promise<SignInStep>;
  chooseWorkspace(selectToken: string, tenantId: string): Promise<SignInStep>;
  signOut(): Promise<void>;
  unlock(): Promise<{ ok: boolean; message?: string }>;
  refreshMe(): Promise<void>;
  setDevice(d: Device): void;
  punch(draft: PunchDraft): Promise<FlushOutcome>;
  sync(): Promise<FlushOutcome | null>;
  dismissRefused(sequence: number): Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

async function installationId() {
  let id = await secret.get(INSTALLATION);
  if (!id) {
    id = randomId();
    await secret.set(INSTALLATION, id);
  }
  return id;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [device, setDevice] = useState<Device | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueState>({ pending: [], refused: [], syncing: false });
  const outbox = useRef<Outbox | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const backgroundAt = useRef<number | null>(null);

  const signedOutLocally = useCallback(() => {
    setMe(null);
    setDevice(null);
    deviceRef.current = null;
    outbox.current = null;
    setStatus((s) => {
      if (s === 'ready' || s === 'locked') setNotice('Your session has ended. Please sign in again.');
      return 'signedOut';
    });
  }, []);

  const api = useMemo(() => new Api(API_URL, tokenStore, () => signedOutLocally()), [signedOutLocally]);

  const loadQueue = useCallback(async (extra: Partial<QueueState> = {}) => {
    const o = outbox.current;
    if (!o) return;
    const [pending, refused] = await Promise.all([o.pending(), o.refused()]);
    setQueue((q) => ({ ...q, ...extra, pending, refused }));
  }, []);

  /** Loads who I am, registers this phone and opens my punch queue. */
  const start = useCallback(async () => {
    const m = await api.get<MeResponse>('/me');
    setMe(m);
    outbox.current = new Outbox(kv, clock, m.membership.id);
    if (m.features.includes('self_service')) {
      const d = await api.post<Device>('/mobile/devices', {
        installationId: await installationId(),
        platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web',
        appVersion: Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '',
        model: (ExpoDevice.modelName ?? (Platform.OS === 'web' ? 'Browser' : '')).slice(0, 80),
        osVersion: (ExpoDevice.osVersion ?? '').slice(0, 40),
      });
      deviceRef.current = d;
      setDevice(d);
    }
    await kv.set(CACHE, JSON.stringify({ me: m, device: deviceRef.current }));
    await loadQueue();
  }, [api, loadQueue]);

  /** Offline at start: use who I was last time, so punches can still be queued. */
  const restore = useCallback(async () => {
    const raw = await kv.get(CACHE);
    if (!raw) return false;
    const c = JSON.parse(raw) as { me: MeResponse; device: Device | null };
    setMe(c.me);
    deviceRef.current = c.device;
    setDevice(c.device);
    outbox.current = new Outbox(kv, clock, c.me.membership.id);
    await loadQueue();
    return true;
  }, [loadQueue]);

  const finishSignIn = useCallback(
    async (r: LoginResponse): Promise<SignInStep> => {
      if (r.status === 'mfa_required') return { step: 'mfa', mfaToken: r.mfaToken };
      if (r.status === 'select_tenant') return { step: 'workspace', selectToken: r.selectToken, workspaces: r.tenants };
      await tokenStore.set(r);
      await start();
      setNotice(null);
      setStatus('ready');
      return { step: 'done' };
    },
    [start],
  );

  // On start: resume the stored session, behind the biometric if it is turned on.
  useEffect(() => {
    (async () => {
      const t = await tokenStore.get();
      if (!t) return setStatus('signedOut');
      if (await biometricEnabled()) return setStatus('locked');
      try {
        await start();
        setStatus('ready');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return; // already signed out
        // Offline (or the server is down): keep the session and work from what is stored; screens retry.
        if (await restore()) setStatus('ready');
        else setStatus('signedOut');
      }
    })();
  }, [start, restore]);

  const sync = useCallback(async () => {
    const o = outbox.current;
    const d = deviceRef.current;
    if (!o || !d) return null;
    if (!(await o.pending()).length) return null;
    setQueue((q) => ({ ...q, syncing: true }));
    const out = await o.flush((body) => api.post('/mobile/punches', { deviceId: d.id, ...body }));
    await loadQueue({ syncing: false, last: { ...out, at: Date.now() } });
    return out;
  }, [api, loadQueue]);

  // Send queued punches when the app comes back, and every minute while some are waiting.
  useEffect(() => {
    if (status !== 'ready') return;
    const sub = AppState.addEventListener('change', async (s) => {
      if (s === 'active') {
        if (backgroundAt.current && Date.now() - backgroundAt.current > RELOCK_AFTER_MS && (await biometricEnabled())) {
          backgroundAt.current = null;
          return setStatus('locked');
        }
        backgroundAt.current = null;
        void sync();
      } else if (s === 'background') backgroundAt.current = Date.now();
    });
    const timer = setInterval(() => void sync(), 60_000);
    void sync();
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [status, sync]);

  const value: SessionValue = {
    status,
    api,
    me,
    device,
    queue,
    notice,
    can: (p) => Boolean(me?.permissions[p]),
    hasFeature: (f) => Boolean(me?.features.includes(f)),
    signIn: async (email, password, workspace) =>
      finishSignIn(await api.publicRequest<LoginResponse>('POST', '/auth/login', { email, password, ...(workspace ? { tenantSlug: workspace } : {}) })),
    async signInWithSso(email) {
      const returnTo = ssoReturnAddress();
      const pkce = await makePkce(
        (n) => Crypto.getRandomBytes(n),
        async (t) => new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new TextEncoder().encode(t))),
      );
      const { authorizationUrl } = await api.publicRequest<{ authorizationUrl: string }>('POST', '/auth/sso/start', { email, returnTo, appChallenge: pkce.challenge });
      if (Platform.OS === 'web') {
        // The preview runs in a browser tab: the tab itself goes to the provider and comes back to /sso.
        window.sessionStorage.setItem(SSO_VERIFIER, pkce.verifier);
        window.location.assign(authorizationUrl);
        return { step: 'redirected' };
      }
      const r = await WebBrowser.openAuthSessionAsync(authorizationUrl, returnTo);
      if (r.type !== 'success') return { step: 'cancelled' };
      const h = readHandoff(r.url, returnTo);
      if ('error' in h) throw new ApiError(401, 'sso_failed', h.error);
      return finishSignIn(await api.publicRequest<LoginResponse>('POST', '/auth/sso/exchange', { code: h.code, verifier: pkce.verifier }));
    },
    async finishSso(code) {
      const verifier = Platform.OS === 'web' ? window.sessionStorage.getItem(SSO_VERIFIER) : null;
      if (Platform.OS === 'web') window.sessionStorage.removeItem(SSO_VERIFIER);
      if (!verifier) throw new ApiError(401, 'sso_failed', 'This sign-in was not started from this app. Start again.');
      return finishSignIn(await api.publicRequest<LoginResponse>('POST', '/auth/sso/exchange', { code, verifier }));
    },
    verifyMfa: async (mfaToken, code) => finishSignIn(await api.publicRequest<LoginResponse>('POST', '/auth/mfa/verify', { mfaToken, code })),
    chooseWorkspace: async (selectToken, tenantId) => finishSignIn(await api.publicRequest<LoginResponse>('POST', '/auth/select-tenant', { selectToken, tenantId })),
    async signOut() {
      // Signing the device out ends this sign-in on the server and stops push to this phone.
      // Punches still queued stay on the phone and are sent after the next sign-in.
      try {
        if (deviceRef.current) await api.post(`/mobile/devices/${deviceRef.current.id}/sign-out`);
        else await api.post('/auth/logout');
      } catch {
        /* offline: the local sign-out still happens; the session expires on its own */
      }
      await tokenStore.clear();
      await kv.set(CACHE, '');
      setNotice(null);
      setMe(null);
      setDevice(null);
      deviceRef.current = null;
      outbox.current = null;
      setStatus('signedOut');
    },
    async unlock() {
      const r = await unlockWithBiometric();
      if (!r.ok) return r;
      try {
        await start();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return { ok: false, message: 'Your session has ended. Please sign in again.' };
        if (!(await restore())) return { ok: false, message: (e as Error).message };
      }
      setStatus('ready');
      return { ok: true };
    },
    refreshMe: async () => setMe(await api.get<MeResponse>('/me')),
    setDevice: (d) => {
      deviceRef.current = d;
      setDevice(d);
    },
    async punch(draft) {
      const o = outbox.current;
      if (!o) throw new ApiError(401, 'signed_out', 'Please sign in again.');
      await o.add(draft);
      await loadQueue();
      return (await sync()) ?? { accepted: 0, duplicates: 0, refused: [], remaining: 0 };
    },
    sync,
    async dismissRefused(sequence) {
      await outbox.current?.dismissRefused(sequence);
      await loadQueue();
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
