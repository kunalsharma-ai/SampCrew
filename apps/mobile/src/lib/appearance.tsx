import { type Appearance, type AppearancePatch, DEFAULT_APPEARANCE, type MemberPreferences } from '@crew/contracts';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useColorScheme } from 'react-native';
import { useSession } from './session';
import { kv } from './storage';
import { cachedAppearance, type MobileTheme, mobileTheme } from './theme';

const CACHE = 'crew.appearance';

interface AppearanceValue {
  appearance: Appearance;
  theme: MobileTheme;
  /** Saves a change to the member's appearance. The app changes at once and goes back if the save fails. */
  update(patch: AppearancePatch): Promise<void>;
}

const Ctx = createContext<AppearanceValue | null>(null);

/**
 * The member's theme, from the same saved preference the Web Portal uses. The last one is kept on the phone so the
 * app opens in it straight away, then refreshed from the server once signed in; signing out goes back to the default.
 */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { status, api, me } = useSession();
  const scheme = useColorScheme();
  const [appearance, setAppearance] = useState<Appearance>(DEFAULT_APPEARANCE);
  const current = useRef(appearance);
  current.current = appearance;

  useEffect(() => {
    void kv.get(CACHE).then((raw) => raw && setAppearance(cachedAppearance(raw)));
  }, []);

  const membership = me?.membership.id ?? null;
  useEffect(() => {
    if (status === 'signedOut') {
      setAppearance(DEFAULT_APPEARANCE);
      void kv.set(CACHE, '');
      return;
    }
    if (status !== 'ready' || !membership) return;
    let live = true;
    api.get<MemberPreferences>('/me/preferences')
      .then((p) => {
        if (!live) return;
        setAppearance(p.appearance);
        void kv.set(CACHE, JSON.stringify(p.appearance));
      })
      .catch(() => {}); // Keep the cached theme when offline.
    return () => { live = false; };
  }, [status, membership, api]);

  const update = useCallback(async (patch: AppearancePatch) => {
    const before = current.current;
    setAppearance({ ...before, ...patch });
    try {
      const saved = await api.put<MemberPreferences>('/me/preferences/appearance', patch);
      setAppearance(saved.appearance);
      await kv.set(CACHE, JSON.stringify(saved.appearance));
    } catch (e) {
      setAppearance(before);
      throw e;
    }
  }, [api]);

  const value = useMemo(() => ({ appearance, theme: mobileTheme(appearance, scheme), update }), [appearance, scheme, update]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The member's appearance and a way to change it. */
export function useAppearance() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAppearance outside AppearanceProvider');
  return v;
}

/** The current palette; outside the provider, the default theme for the phone's light or dark setting. */
export function useAppearanceTheme(): MobileTheme {
  const v = useContext(Ctx);
  const scheme = useColorScheme();
  return v?.theme ?? mobileTheme(DEFAULT_APPEARANCE, scheme);
}
