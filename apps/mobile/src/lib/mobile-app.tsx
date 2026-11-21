import type { ResolvedMobileApp, ResolvedMobileModule } from '@crew/contracts';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useSession } from './session';
import { kv } from './storage';

/** How often an open app checks whether the Super Workspace published a new configuration. */
const POLL_MS = 60_000;
const CACHE = 'crew.mobileApp';

export type MobileAppState = {
  /** null until the first answer (or cached copy) arrives. */
  app: ResolvedMobileApp | null;
  /** A module, or module.feature, is on for me. */
  has(key: string): boolean;
  module(key: string): ResolvedMobileModule | undefined;
  /** Ask the server again now (after a refusal, or pull to refresh). */
  refresh(): Promise<void>;
  /** Shown while the last check could not reach the server; the cached menu stays in use. */
  stale: boolean;
};

const Ctx = createContext<MobileAppState | null>(null);

export function useMobileApp(): MobileAppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMobileApp outside MobileAppProvider');
  return v;
}

/** Whether the last configuration check failed (no connection), for the offline bar; false outside the provider. */
export function useAppStale(): boolean {
  return useContext(Ctx)?.stale ?? false;
}

/** Whether a resolved app has a module or module.feature (pure, for tests and the provider). */
export function appHas(app: ResolvedMobileApp | null, key: string): boolean {
  if (!app) return false;
  const [m, f] = key.split('.');
  const mod = app.modules.find((x) => x.key === m);
  return Boolean(mod && (!f || mod.features.includes(f)));
}

/**
 * Keeps the phone's menu in step with the configuration the Super Workspace published: loaded at start (from the
 * last copy at once, then from the server), checked every minute while the app is open and whenever it comes back,
 * and straight away when the server refuses a hidden module. Nobody has to reinstall or refresh anything.
 */
export function MobileAppProvider({ children }: { children: ReactNode }) {
  const { api, status, me } = useSession();
  const [app, setApp] = useState<ResolvedMobileApp | null>(null);
  const [stale, setStale] = useState(false);
  const version = useRef<number | undefined>(undefined);
  const key = me ? `${CACHE}.${me.membership.id}` : null;

  // The last menu this person had on this phone, so the app opens with it even offline.
  useEffect(() => {
    if (!key) return void setApp(null);
    let live = true;
    void kv.get(key).then((raw) => {
      if (!live || !raw) return;
      try {
        const cached = JSON.parse(raw) as ResolvedMobileApp;
        setApp((cur) => cur ?? cached);
        version.current ??= cached.version;
      } catch {
        /* an unreadable copy is ignored; the server answer replaces it */
      }
    });
    return () => {
      live = false;
    };
  }, [key]);

  const refresh = useCallback(async () => {
    if (status !== 'ready' || !key) return;
    try {
      const since = version.current;
      const next = await api.get<ResolvedMobileApp & { unchanged: boolean }>(`/mobile/app${since !== undefined ? `?since=${since}` : ''}`);
      setStale(false);
      // The level or permissions can change without a new version, so the menu is always taken from the answer.
      const { unchanged: _u, ...fresh } = next;
      version.current = fresh.version;
      setApp((cur) => (cur && JSON.stringify(cur) === JSON.stringify(fresh) ? cur : fresh));
      await kv.set(key, JSON.stringify(fresh));
    } catch {
      setStale(true);
    }
  }, [api, status, key]);

  useEffect(() => {
    if (status !== 'ready') return;
    void refresh();
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void refresh();
    }, POLL_MS);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && void refresh());
    api.onModuleOff = () => void refresh();
    return () => {
      clearInterval(timer);
      sub.remove();
      api.onModuleOff = null;
    };
  }, [status, refresh, api]);

  // Stable while the menu is the same, so screens can list them as effect dependencies without reloading.
  const has = useCallback((k: string) => appHas(app, k), [app]);
  const module = useCallback((k: string) => app?.modules.find((m) => m.key === k), [app]);
  const value = useMemo<MobileAppState>(() => ({ app, stale, refresh, has, module }), [app, stale, refresh, has, module]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
